/**
 * POST /api/webhooks/ghl/message?org=<uuid> — go-forward GHL conversation capture.
 *
 * Some lead segments still text/email GHL-owned numbers, so their threads would
 * otherwise never reach LI and the AI would engage them blind. GHL's workflow
 * "Webhook" action (or a Marketplace InboundMessage/OutboundMessage hook) POSTs
 * each message here; we mirror it into LI's conversation store.
 *
 * CAPTURE-ONLY by design: we persist the message and fold in TCPA opt-out state,
 * but we do NOT auto-respond. GHL segments may still run their own automation —
 * replying from here risks double-sends and loops. LI's AI engages a lead only
 * through its normal, consent-gated paths.
 *
 * Auth: a static shared secret (x-ghl-webhook-secret == GHL_WEBHOOK_SECRET,
 * timing-safe) plus a valid ?org= — GHL cannot compute a body HMAC, so a strong
 * static secret + the org guard is the pragmatic contract.
 */

import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { validateOrgId, applyDistributedRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { searchHash } from '@/lib/encryption'
import { formatToE164 } from '@/lib/leads/phone'
import { getGhlConfig, getContact } from '@/lib/ghl/client'
import {
  normalizeGhlMessage,
  type GhlMessage,
  type NormalizedGhlMessage,
} from '@/lib/ghl/conversations'
import { persistGhlMessage, type IngestLead } from '@/lib/ghl/ingest-message'
import { createLeadFromSocialDm, isNewSocialLead } from '@/lib/ghl/social-lead'
import { logger } from '@/lib/logger'

/** Constant-time secret comparison; false on any length/format mismatch. */
function secretMatches(provided: string | null, expected: string | undefined): boolean {
  if (!provided || !expected) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * GHL sends message events in a few shapes (Marketplace hook vs. workflow
 * webhook). Read the union defensively: `type` encodes direction on the
 * Marketplace hook (InboundMessage/OutboundMessage); a bare `direction` field
 * is the fallback. Field names are otherwise stable.
 */
function extractMessage(payload: Record<string, unknown>): {
  contactId: string | null
  ghlMessage: GhlMessage
} | null {
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  const id = str(payload.messageId) || str(payload.id)
  const contactId = str(payload.contactId) || null
  if (!id) return null

  const typeField = (str(payload.type) || '').toLowerCase()
  const direction =
    str(payload.direction) ||
    (typeField.includes('outbound') ? 'outbound' : typeField.includes('inbound') ? 'inbound' : undefined)

  return {
    contactId,
    ghlMessage: {
      id,
      messageType: str(payload.messageType),
      body: str(payload.body),
      direction,
      dateAdded: str(payload.dateAdded) || str(payload.dateUpdated),
      subject: str(payload.subject),
      conversationId: str(payload.conversationId),
      contactId: contactId ?? undefined,
    },
  }
}

export async function POST(request: NextRequest) {
  const rlError = await applyDistributedRateLimit(request, RATE_LIMITS.webhook, 'wh-ghl-msg')
  if (rlError) return rlError

  if (!secretMatches(request.headers.get('x-ghl-webhook-secret'), process.env.GHL_WEBHOOK_SECRET)) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  const orgResult = await validateOrgId(new URL(request.url).searchParams.get('org'))
  if (orgResult instanceof NextResponse) return orgResult
  const { orgId } = orgResult

  let payload: Record<string, unknown>
  try {
    payload = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const extracted = extractMessage(payload)
  if (!extracted) {
    return NextResponse.json({ error: 'Missing message id' }, { status: 400 })
  }

  const normalized = normalizeGhlMessage(extracted.ghlMessage)
  if (!normalized) {
    // Unsupported channel or empty body — ack so GHL doesn't retry forever.
    return NextResponse.json({ ok: true, action: 'ignored' })
  }

  const supabase = createServiceClient()
  let lead = await resolveLead(supabase, orgId, extracted.contactId)

  if (!lead && isNewSocialLead(normalized)) {
    // An inbound social DM from someone we've never seen IS the lead event —
    // see src/lib/ghl/social-lead.ts for why social can't wait for a bridge.
    const config = await getGhlConfig(supabase, orgId)
    if (config) {
      lead = await createLeadFromSocialDm(supabase, orgId, config, extracted.contactId, normalized)
    }
  }

  if (!lead) {
    // Unknown contact — nothing to attach to. Ack (a lead may arrive later via
    // the DGS bridge; the backfill will pick up this thread then).
    return NextResponse.json({ ok: true, action: 'no_lead' })
  }

  try {
    const result = await persistGhlMessage(supabase, {
      organizationId: orgId,
      lead,
      normalized,
      bumpCounters: true,
    })
    return NextResponse.json({ ok: true, action: result.status })
  } catch (err) {
    logger.error('GHL message webhook persist failed', {
      orgId,
      externalId: normalized.externalId,
      error: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ error: 'persist_failed' }, { status: 500 })
  }
}

/**
 * Resolve the LI lead for a GHL contact: direct key first, then self-heal by
 * fetching the GHL contact and matching on the phone/email search hash (writing
 * ghl_contact_id back so the next event goes direct).
 */
async function resolveLead(
  supabase: ReturnType<typeof createServiceClient>,
  orgId: string,
  contactId: string | null,
): Promise<IngestLead | null> {
  if (!contactId) return null

  const direct = await supabase
    .from('leads')
    .select('id, first_name, last_name')
    .eq('organization_id', orgId)
    .eq('ghl_contact_id', contactId)
    .limit(1)
    .maybeSingle()
  if (direct.data) return direct.data as IngestLead

  // Fall back to a hash match via the GHL contact record.
  const config = await getGhlConfig(supabase, orgId)
  if (!config) return null
  const contact = await getContact(config, contactId)
  if (!contact) return null

  const email = contact.email?.trim() || null
  const phone = contact.phone ? formatToE164(contact.phone.trim()) : null
  const emailHash = email ? searchHash(email) : null
  const phoneHash = phone ? searchHash(phone) : null
  if (!emailHash && !phoneHash) return null

  const orFilter = [
    emailHash ? `email_hash.eq.${emailHash}` : null,
    phoneHash ? `phone_hash.eq.${phoneHash}` : null,
  ]
    .filter(Boolean)
    .join(',')

  const { data: matched } = await supabase
    .from('leads')
    .select('id, first_name, last_name')
    .eq('organization_id', orgId)
    .or(orFilter)
    .limit(1)
    .maybeSingle()
  if (!matched) return null

  // Self-heal the mapping so future events skip the contact fetch.
  await supabase.from('leads').update({ ghl_contact_id: contactId }).eq('id', matched.id)
  return matched as IngestLead
}
