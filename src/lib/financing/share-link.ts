/**
 * Financing share-link helper.
 *
 * Creates (or reuses) a `financing_applications` row with a share token and
 * returns the public `/finance/{token}` URL the patient can complete OR forward
 * to a co-signer / family member to apply on their behalf. This is the
 * "friends & family funding" mechanism used by the post-consult funding nurture
 * (Step 6 — co-signer recruitment).
 *
 * Mirrors the token-creation in POST /api/financing/send-link, but is callable
 * from server-side jobs (the campaign executor) without an HTTP request.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import crypto from 'crypto'

export type FinancingShareLink = {
  url: string
  shareToken: string
  applicationId: string
}

const DEFAULT_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000 // 30 days — long enough for a co-signer to receive & act.

/**
 * Get the active financing share link for a lead, creating a pending
 * application + token if none exists. Returns null only on a create failure or
 * when the app URL base is not configured.
 */
export async function getOrCreateFinancingShareLink(
  supabase: SupabaseClient,
  params: {
    organizationId: string
    leadId: string
    requestedAmount?: number | null
    expiresInMs?: number
  }
): Promise<FinancingShareLink | null> {
  const appBase = process.env.NEXT_PUBLIC_APP_URL
  if (!appBase) return null

  // Reuse an existing open application's token so a patient who already has a
  // link doesn't get a second, conflicting one.
  const { data: existing } = await supabase
    .from('financing_applications')
    .select('id, share_token')
    .eq('lead_id', params.leadId)
    .in('status', ['pending', 'in_progress'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; share_token: string | null }>()

  if (existing?.share_token) {
    return {
      url: `${appBase}/finance/${existing.share_token}`,
      shareToken: existing.share_token,
      applicationId: existing.id,
    }
  }

  const shareToken = crypto.randomBytes(32).toString('hex')
  const { data: created, error } = await supabase
    .from('financing_applications')
    .insert({
      organization_id: params.organizationId,
      lead_id: params.leadId,
      status: 'pending',
      requested_amount: params.requestedAmount ?? null,
      share_token: shareToken,
      // NOTE: `consent_given_at` is NOT NULL with a DB default of now(). Do NOT
      // pass it here — an explicit null overrides the default and fails the
      // insert, silently dropping the co-signer link. Real consent is recorded
      // (overwriting this) when the applicant submits in POST /api/financing/apply.
      expires_at: new Date(Date.now() + (params.expiresInMs ?? DEFAULT_EXPIRY_MS)).toISOString(),
      waterfall_config: { lenders: [] },
      applicant_data_encrypted: null,
    })
    .select('id')
    .single<{ id: string }>()

  if (error || !created) return null

  return {
    url: `${appBase}/finance/${shareToken}`,
    shareToken,
    applicationId: created.id,
  }
}
