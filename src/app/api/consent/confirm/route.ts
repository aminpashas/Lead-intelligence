/**
 * POST /api/consent/confirm — public consent-capture confirmation (Phase 1.2).
 *
 * Backs the /optin/<token> page. Validates the single-use token and, on success,
 * flips the lead's consent booleans for the token's channels → status 'granted'
 * (via the sync_consent_status trigger; the grant is also written to consent_log).
 * Runs as service role because the lead has no session and the leads row is
 * RLS-protected. Single-use is enforced by claiming the token (pending→confirmed)
 * before applying consent, so a double-submit can't grant twice.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import {
  isTokenUsable,
  consentGrantFields,
  optInDisclosureSentence,
  type ConsentCaptureChannel,
} from '@/lib/consent/capture'

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { token?: string } | null
  const token = body?.token
  if (!token) return NextResponse.json({ error: 'token is required' }, { status: 400 })

  const service = createServiceClient()

  const { data: row } = await service
    .from('consent_capture_tokens')
    .select('id, lead_id, organization_id, channels, status, expires_at')
    .eq('token', token)
    .maybeSingle()

  if (!row) return NextResponse.json({ error: 'invalid_token' }, { status: 404 })

  const usable = isTokenUsable({ status: row.status, expires_at: row.expires_at })
  if (!usable.usable) {
    const status = usable.reason === 'expired' ? 410 : 409
    return NextResponse.json({ error: usable.reason }, { status })
  }

  const channels = (row.channels ?? ['sms', 'email']).filter(
    (c: string): c is ConsentCaptureChannel => c === 'sms' || c === 'email' || c === 'voice'
  )

  // Claim the token (pending → confirmed) atomically. If no row comes back, a
  // concurrent request already claimed it — treat as already used.
  const nowIso = new Date().toISOString()
  const { data: claimed } = await service
    .from('consent_capture_tokens')
    .update({ status: 'confirmed', confirmed_at: nowIso })
    .eq('id', row.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle()
  if (!claimed) return NextResponse.json({ error: 'already_used' }, { status: 409 })

  const grant = consentGrantFields(channels, nowIso)

  const { error: updErr } = await service
    .from('leads')
    .update(grant)
    .eq('id', row.lead_id)
    .eq('organization_id', row.organization_id)

  if (updErr) {
    return NextResponse.json({ error: 'consent_write_failed', detail: updErr.message }, { status: 500 })
  }

  // Best-effort consent artifact: store exactly what was disclosed + who confirmed
  // (IP / user-agent). The consent grant above + consent_log are the operative
  // record, so never fail the opt-in if this supplementary write errors (e.g. if
  // the columns aren't migrated yet).
  try {
    const { data: org } = await service
      .from('organizations')
      .select('name')
      .eq('id', row.organization_id)
      .maybeSingle()
    const confirmedIp =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      null
    await service
      .from('consent_capture_tokens')
      .update({
        confirmed_ip: confirmedIp,
        confirmed_user_agent: request.headers.get('user-agent'),
        disclosure_text: optInDisclosureSentence(channels, org?.name ?? ''),
      })
      .eq('id', row.id)
  } catch {
    // Artifact is supplementary; the consent grant is already recorded.
  }

  return NextResponse.json({ ok: true, channels })
}
