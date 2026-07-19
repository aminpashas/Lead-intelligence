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
import { after } from 'next/server'
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
import { ingestLead } from '@/lib/leads/ingest'
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
    // it's how a stranger first contacts the practice on FB/IG. Unlike SMS or
    // email (where the number/address implies a prior touch that the DGS bridge
    // will land), a Messenger DM has no other arrival path: Meta hands over a
    // name and nothing else, so waiting for a bridge means waiting forever.
    lead = await createLeadFromSocialDm(supabase, orgId, extracted.contactId, normalized)
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

/** Per-channel presentation for a social DM lead. */
const SOCIAL_SOURCE: Record<string, { source: string; sourceType: string; utmSource: string }> = {
  messenger: { source: 'Messenger', sourceType: 'messenger', utmSource: 'facebook' },
  instagram: { source: 'Instagram DM', sourceType: 'instagram', utmSource: 'instagram' },
}

/** Only an INBOUND social DM mints a lead — our own outbound reply must not. */
function isNewSocialLead(n: NormalizedGhlMessage): boolean {
  return n.direction === 'inbound' && n.channel !== null && n.channel in SOCIAL_SOURCE
}

/**
 * Create a lead from an inbound FB/IG DM by an unknown GHL contact, and fire the
 * staff new-lead alert.
 *
 * Meta gives a display name and no contact details, so `ingestLead`'s usual
 * email/phone dedup can't match — `externalRef` (the GHL contact id) is the
 * stable key, and `ghl_contact_id` is written so every later message in the
 * thread resolves directly.
 *
 * Consent is left UNKNOWN on sms/email/voice: they messaged a social page, which
 * is not permission to text or call. Nothing auto-contacts them until the
 * re-permission flow earns it. `armSpeedToLead` is off for the same reason —
 * there is no consented channel to be fast on, and LI cannot reply in Messenger
 * (GHL owns that inbox), so the alert to staff IS the follow-up.
 */
async function createLeadFromSocialDm(
  supabase: ReturnType<typeof createServiceClient>,
  orgId: string,
  contactId: string | null,
  normalized: NormalizedGhlMessage,
): Promise<IngestLead | null> {
  if (!contactId) return null
  const preset = SOCIAL_SOURCE[normalized.channel as string]
  if (!preset) return null

  const config = await getGhlConfig(supabase, orgId)
  if (!config) return null
  const contact = await getContact(config, contactId)
  if (!contact) return null

  // GHL splits the Meta display name inconsistently across revisions; fall back
  // to `name` and let ingestLead's guard strip anything phone-shaped.
  const first = contact.firstName?.trim() || contact.name?.trim().split(/\s+/)[0] || ''
  const last =
    contact.lastName?.trim() || contact.name?.trim().split(/\s+/).slice(1).join(' ') || null
  if (!first) return null

  let result
  try {
    result = await ingestLead(
      supabase,
      {
        organizationId: orgId,
        firstName: first,
        lastName: last,
        email: contact.email?.trim() || null,
        phoneRaw: contact.phone?.trim() || null,
        source: preset.source,
        sourceType: preset.sourceType,
        externalRef: contactId,
        tags: [normalized.channel as string],
        notes: normalized.body ? `First ${preset.source} message: ${normalized.body}` : null,
        consent: { source: `ghl_${normalized.channel}_dm` },
        utm_source: preset.utmSource,
      },
      { caller: `ghl-${normalized.channel}-dm`, armSpeedToLead: false },
    )
  } catch (err) {
    logger.error('social DM lead creation failed', {
      orgId,
      contactId,
      channel: normalized.channel,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }

  await supabase.from('leads').update({ ghl_contact_id: contactId }).eq('id', result.id)

  if (!result.deduplicated) {
    after(async () => {
      await result.runPostIngest()
      try {
        const { notifyNewLead } = await import('@/lib/notifications/new-lead-alert')
        await notifyNewLead(supabase, {
          organizationId: orgId,
          lead: {
            id: result.id,
            firstName: first,
            lastName: last,
            source: preset.source,
            tags: [normalized.channel as string],
            utm_source: preset.utmSource,
            utm_medium: 'social',
            message: normalized.body || null,
          },
          // The DM's own timestamp — a replayed/backfilled thread must not blast
          // a fresh-lead alert months after the fact.
          sourceCreatedAt: normalized.createdAt,
        })
      } catch {
        /* staff alert is best-effort — never blocks capture */
      }
    })
  }

  return { id: result.id, first_name: first, last_name: last }
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
