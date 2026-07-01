/**
 * POST /api/v1/consent — service-key consent-sync receiver (close-the-loop).
 *
 * The GHL/DGS bridge sends consent CHANGES for leads that already exist in LI —
 * the events that happen in GoHighLevel, not on LI's hosted /optin page:
 *   - a lead replies YES / re-subscribes        → action 'opt_in'
 *   - a lead replies STOP or lands in GHL DND    → action 'opt_out'
 *
 * Why this exists: the /api/v1/leads bridge only sets consent on lead CREATION
 * ("consent left untouched on a dedup hit"), and it wrote opt-outs as status
 * 'declined' WITHOUT the hard `sms_opt_out` flag — which is why LI showed
 * sms_opt_out=0 while 1k+ leads were really opted out in GHL. This endpoint
 * writes the real, timestamped opt-out/opt-in onto the EXISTING lead, then the
 * DB triggers (sync_consent_status + log_consent_change) derive status and append
 * the consent_log audit row automatically.
 *
 * Auth + tenancy mirror /api/v1/leads (same GROWTH_STUDIO_SERVICE_KEY caller).
 * Naturally idempotent: re-sending the same opt-out/opt-in is a no-op (the
 * trigger's IS DISTINCT FROM guards prevent duplicate consent_log rows).
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { verifyServiceKey, isOrgAllowed } from '@/lib/auth/service-key'
import { searchHash } from '@/lib/encryption'
import { formatToE164 } from '@/lib/leads/phone'
import { safeParseBody } from '@/lib/body-size'
import {
  consentGrantFields,
  consentRevokeFields,
  type ConsentCaptureChannel,
} from '@/lib/consent/capture'

function serviceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase service role not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

const bodySchema = z
  .object({
    customer_id: z.string().uuid(),
    action: z.enum(['opt_in', 'opt_out']),
    channels: z.array(z.enum(['sms', 'email', 'voice'])).min(1),
    // Lead resolution — at least one is required (validated below).
    external_ref: z.string().min(1).optional(),
    email: z.string().email().optional(),
    phone: z.string().min(1).optional(),
    // Provenance of the consent decision, e.g. 'ghl_reply_yes', 'ghl_dnd', 'ghl_stop'.
    source: z.string().min(1).max(120).optional(),
    // When it happened in GHL (ISO). Defaults to now if omitted/invalid.
    occurred_at: z.string().datetime().optional(),
  })
  .refine((b) => b.external_ref || b.email || b.phone, {
    message: 'one of external_ref, email, or phone is required to resolve the lead',
  })

export async function POST(request: NextRequest) {
  const auth = verifyServiceKey(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: raw, error: bodyError } = await safeParseBody(request)
  if (bodyError) return bodyError

  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', details: parsed.error.flatten() },
      { status: 400 }
    )
  }
  const body = parsed.data

  // Multi-tenant guard — before any DB query.
  if (!isOrgAllowed(auth, body.customer_id)) {
    return NextResponse.json({ error: 'forbidden_org' }, { status: 403 })
  }

  const channels = body.channels as ConsentCaptureChannel[]
  const occurredAt =
    body.occurred_at && !Number.isNaN(Date.parse(body.occurred_at))
      ? new Date(body.occurred_at).toISOString()
      : new Date().toISOString()

  const supabase = serviceRoleClient()

  // ── Resolve the existing lead ────────────────────────────────────────────
  // external_ref (DGS inbound_leads.id, indexed) is preferred and exact; fall
  // back to hashed email/phone lookup within the org (same hashing the bridge
  // uses for dedup, so a lead created by the bridge resolves here too).
  let lead: { id: string } | null = null

  if (body.external_ref) {
    const { data } = await supabase
      .from('leads')
      .select('id')
      .eq('organization_id', body.customer_id)
      .eq('external_ref', body.external_ref)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    lead = data
  }

  if (!lead && (body.email || body.phone)) {
    const emailHash = body.email ? searchHash(body.email) : null
    const phoneE164 = body.phone ? formatToE164(body.phone) : null
    const phoneHash = phoneE164 || body.phone ? searchHash(phoneE164 || body.phone!) : null
    const orFilter = [
      emailHash ? `email_hash.eq.${emailHash}` : null,
      phoneHash ? `phone_hash.eq.${phoneHash}` : null,
    ]
      .filter(Boolean)
      .join(',')
    if (orFilter) {
      const { data } = await supabase
        .from('leads')
        .select('id')
        .eq('organization_id', body.customer_id)
        .or(orFilter)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      lead = data
    }
  }

  if (!lead) {
    return NextResponse.json({ error: 'lead_not_found' }, { status: 404 })
  }

  // ── Apply the consent change ─────────────────────────────────────────────
  // opt_out: set the hard opt-out flag (+ timestamp) → trigger sets 'declined'
  //          and logs the revoke. opt_in: set consent TRUE (+ timestamp/source)
  //          AND clear any prior opt-out for that channel — a fresh affirmative
  //          opt-in (re-subscribe) supersedes an earlier STOP. Triggers set
  //          'granted' and log the grant.
  let update: Record<string, unknown>
  if (body.action === 'opt_out') {
    update = consentRevokeFields(channels, occurredAt)
  } else {
    update = consentGrantFields(channels, occurredAt, body.source ?? 'ghl_sync')
    for (const ch of channels) update[`${ch}_opt_out`] = false
  }

  const { error: updErr } = await supabase
    .from('leads')
    .update(update)
    .eq('id', lead.id)
    .eq('organization_id', body.customer_id)

  if (updErr) {
    return NextResponse.json(
      { error: 'consent_write_failed', detail: updErr.message },
      { status: 500 }
    )
  }

  // Activity breadcrumb (best-effort; never fail the sync on a logging error).
  try {
    await supabase.from('lead_activities').insert({
      organization_id: body.customer_id,
      lead_id: lead.id,
      activity_type: body.action === 'opt_out' ? 'consent_revoked' : 'consent_granted',
      title: `${body.action === 'opt_out' ? 'Opt-out' : 'Opt-in'} synced from ${auth.caller}`,
      description: `channels: ${channels.join(', ')}${body.source ? ` · source: ${body.source}` : ''}`,
    })
  } catch {
    // Audit log row is written by the DB trigger; this breadcrumb is supplementary.
  }

  return NextResponse.json({
    ok: true,
    lead_id: lead.id,
    action: body.action,
    channels,
  })
}
