/**
 * GET /api/campaigns/review-drafts — pending review_first drafts for the org.
 *
 * The read side of the campaign draft-approval queue. Returns pending drafts
 * (newest first) with light lead + campaign labels so the review UI can render a
 * queue. Org-scoped via the active org (honors an agency_admin's entered client).
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'

export async function GET(_request: NextRequest) {
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabase
    .from('campaign_review_drafts')
    .select('id, campaign_id, lead_id, channel, subject, body, created_at, campaign:campaigns(name), lead:leads(first_name, last_name)')
    .eq('organization_id', orgId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) return NextResponse.json({ error: 'Failed to load drafts' }, { status: 500 })
  return NextResponse.json({ drafts: data ?? [] })
}
