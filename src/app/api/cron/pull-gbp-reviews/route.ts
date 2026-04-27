/**
 * Daily GBP review pull.
 *
 * For every org with a `google_reviews` connector configured (and the GBP-pull credentials
 * present), fetch the latest reviews, sentiment-score new ones, and draft staff-approval
 * responses. Drafts surface in the dashboard for staff to publish manually.
 *
 * Schedule: 07:15 UTC daily (vercel.json).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { pullReviewsForOrg, type GbpReviewsConfig } from '@/lib/connectors/google-business/pull-reviews'

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()

  // All orgs that have a google_reviews connector configured AND it's enabled.
  // (The same connector slot holds both the outbound review-request settings and
  // the GBP API pull credentials — they're related concerns for the same Place.)
  const { data: configs } = await supabase
    .from('connector_configs')
    .select('organization_id, credentials')
    .eq('connector_type', 'google_reviews')
    .eq('enabled', true)

  if (!configs || configs.length === 0) {
    return NextResponse.json({ message: 'No GBP connectors configured', orgs: 0 })
  }

  const results: Array<{
    organization_id: string
    fetched: number
    new: number
    analyzed: number
    drafted: number
    error?: string
  }> = []

  const { decryptCredentials } = await import('@/lib/connectors/crypto')
  for (const cfg of configs as Array<{ organization_id: string; credentials: Record<string, string> }>) {
    const creds = decryptCredentials(cfg.credentials || {}) as Record<string, string>
    // Only orgs that have completed the OAuth flow (refresh_token present) are pulled.
    if (!creds.account_name || !creds.location_id || !creds.refresh_token || !creds.client_id || !creds.client_secret) {
      results.push({
        organization_id: cfg.organization_id,
        fetched: 0,
        new: 0,
        analyzed: 0,
        drafted: 0,
        error: 'gbp_pull_credentials_missing',
      })
      continue
    }

    const config: GbpReviewsConfig = {
      account_name: creds.account_name,
      location_id: creds.location_id,
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
    }

    const result = await pullReviewsForOrg(supabase, cfg.organization_id, config)
    results.push({ organization_id: cfg.organization_id, ...result })
  }

  return NextResponse.json({ orgs: results.length, results })
}

export const GET = POST
