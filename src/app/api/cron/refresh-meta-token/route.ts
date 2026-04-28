/**
 * GET /api/cron/refresh-meta-token
 *
 * Daily sweep that re-rolls Meta long-lived access tokens before they
 * hit their ~60-day expiry. We extend any meta_capi connector whose
 * `settings.token_expires_at` is within 7 days of now (and orgs whose
 * token is missing the expiry field — defensive backfill).
 *
 * Meta's "exchange a long-lived token for a long-lived token" is the
 * same `fb_exchange_token` grant we used on the initial OAuth callback.
 * Calling it before expiry returns a fresh 60-day token; calling it
 * after expiry fails and the user has to manually reconnect.
 *
 * Auth: Bearer CRON_SECRET, same convention as the rest of /api/cron/*.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { decryptCredentials, encryptCredentials } from '@/lib/connectors/crypto'
import { exchangeForLongLivedToken, probeMetaToken } from '@/lib/connectors/oauth/meta'

const REFRESH_WINDOW_DAYS = 7

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!process.env.META_APP_ID || !process.env.META_APP_SECRET) {
    return NextResponse.json({ error: 'meta_oauth_not_configured', refreshed: 0 })
  }

  const supabase = createServiceClient()

  // Pull every meta_capi connector. We include disabled ones too — a
  // user might have paused the connector but we still want to keep the
  // token alive so they can re-enable without reconnecting.
  const { data: configs } = await supabase
    .from('connector_configs')
    .select('id, organization_id, credentials, settings, enabled')
    .eq('connector_type', 'meta_capi')

  if (!configs || configs.length === 0) {
    return NextResponse.json({ message: 'no_meta_connectors', refreshed: 0 })
  }

  const now = Date.now()
  const refreshThreshold = now + REFRESH_WINDOW_DAYS * 86400_000

  type RunResult = {
    organization_id: string
    action: 'refreshed' | 'skipped_not_due' | 'skipped_no_token' | 'failed_probe' | 'failed_exchange' | 'failed_persist'
    error?: string
    new_expires_at?: string
  }
  const results: RunResult[] = []

  for (const cfg of configs as Array<{
    id: string
    organization_id: string
    credentials: Record<string, unknown>
    settings: Record<string, unknown> | null
    enabled: boolean
  }>) {
    const orgId = cfg.organization_id
    const settings = cfg.settings || {}
    const expiresAtStr = (settings as { token_expires_at?: string | null }).token_expires_at
    const expiresAtMs = expiresAtStr ? new Date(expiresAtStr).getTime() : null

    // Skip rows that are well within the safe window. If the field is
    // missing entirely, we treat that as "needs refresh" since we can't
    // tell when the token expires otherwise.
    if (expiresAtMs && expiresAtMs > refreshThreshold) {
      results.push({ organization_id: orgId, action: 'skipped_not_due' })
      continue
    }

    const decrypted = decryptCredentials(cfg.credentials)
    const accessToken = (decrypted as { accessToken?: string }).accessToken
    if (!accessToken) {
      results.push({ organization_id: orgId, action: 'skipped_no_token' })
      continue
    }

    // Sanity check the existing token first — if it's already invalid
    // (revoked, expired) the refresh exchange below would fail anyway,
    // and the failure mode is more informative if we surface it here.
    const probe = await probeMetaToken(accessToken).catch(() => null)
    if (!probe) {
      results.push({
        organization_id: orgId,
        action: 'failed_probe',
        error: 'token_invalid_or_revoked',
      })
      continue
    }

    let fresh
    try {
      fresh = await exchangeForLongLivedToken(accessToken)
    } catch (err) {
      results.push({
        organization_id: orgId,
        action: 'failed_exchange',
        error: err instanceof Error ? err.message : 'unknown',
      })
      continue
    }

    const newExpiresAt = fresh.expires_in
      ? new Date(now + fresh.expires_in * 1000).toISOString()
      : null

    // Re-encrypt only the access_token field; keep pixelId / adAccountId
    // / testEventCode untouched. We rebuild the credentials object so
    // any future fields added by the OAuth flow survive the refresh.
    const updatedCredentials = encryptCredentials({
      ...decrypted,
      accessToken: fresh.access_token,
    })
    const updatedSettings = {
      ...settings,
      token_expires_at: newExpiresAt,
    }

    const { error: updErr } = await supabase
      .from('connector_configs')
      .update({
        credentials: updatedCredentials,
        settings: updatedSettings,
        updated_at: new Date().toISOString(),
      })
      .eq('id', cfg.id)

    if (updErr) {
      results.push({
        organization_id: orgId,
        action: 'failed_persist',
        error: updErr.message,
      })
      continue
    }

    results.push({
      organization_id: orgId,
      action: 'refreshed',
      new_expires_at: newExpiresAt ?? undefined,
    })
  }

  const refreshedCount = results.filter(r => r.action === 'refreshed').length
  const failedCount = results.filter(r => r.action.startsWith('failed_')).length

  return NextResponse.json({
    examined: results.length,
    refreshed: refreshedCount,
    failed: failedCount,
    results,
  })
}
