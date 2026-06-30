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
import { isTokenUsable, consentGrantFields, type ConsentCaptureChannel } from '@/lib/consent/capture'

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

  const channels = (row.channels ?? ['sms', 'email']).filter(
    (c: string): c is ConsentCaptureChannel => c === 'sms' || c === 'email' || c === 'voice'
  )
  const grant = consentGrantFields(channels, nowIso)

  const { error: updErr } = await service
    .from('leads')
    .update(grant)
    .eq('id', row.lead_id)
    .eq('organization_id', row.organization_id)

  if (updErr) {
    return NextResponse.json({ error: 'consent_write_failed', detail: updErr.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, channels })
}
