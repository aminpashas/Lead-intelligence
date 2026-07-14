import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { hasPermission } from '@/lib/auth/permissions'
import { decryptField } from '@/lib/encryption'
import { ReviewQueue, type ReviewDraft } from '@/components/crm/campaign-review-queue'

/**
 * Campaigns → Review Queue. The human-approval surface for campaigns running in
 * `review_first` autopilot mode: each queued touch is shown with its full body
 * so a staffer can approve (sends via the consent-gated messaging layer) or
 * reject (sends nothing). Server-fetches pending drafts and decrypts the lead
 * name for display (names are encrypted at rest — see pii-decrypt-server-pages).
 */
export default async function CampaignReviewPage() {
  const supabase = await createClient()

  // Effective org honors an agency_admin's entered client account.
  const { orgId, role } = await resolveActiveOrg(supabase)
  if (!orgId) return null

  // Approving a draft sends it — same campaigns:write gate as the route map
  // (nav hiding is a courtesy; this is the boundary).
  if (!hasPermission(role || 'member', 'campaigns:write')) redirect('/dashboard')

  const { data } = await supabase
    .from('campaign_review_drafts')
    .select('id, campaign_id, lead_id, channel, subject, body, created_at, campaign:campaigns(name), lead:leads(first_name, last_name)')
    .eq('organization_id', orgId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(200)

  const drafts: ReviewDraft[] = (data ?? []).map((d: any) => {
    const first = decryptField(d.lead?.first_name) ?? d.lead?.first_name ?? ''
    const last = decryptField(d.lead?.last_name) ?? d.lead?.last_name ?? ''
    const leadName = `${first} ${last}`.trim() || 'Unknown lead'
    return {
      id: d.id,
      lead_id: d.lead_id,
      lead_name: leadName,
      campaign_name: d.campaign?.name ?? 'Campaign',
      channel: d.channel,
      subject: d.subject,
      body: d.body,
      created_at: d.created_at,
    }
  })

  return <ReviewQueue initialDrafts={drafts} />
}
