import { createClient } from '@/lib/supabase/server'
import { CampaignsList } from '@/components/crm/campaigns-list'
import { resolveActiveOrg } from '@/lib/auth/active-org'

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ smart_list_id?: string }>
}) {
  const supabase = await createClient()
  const { smart_list_id } = await searchParams

  // Effective org honors an agency_admin's entered client account.
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return null

  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('*, steps:campaign_steps(count), enrollments:campaign_enrollments(count), smart_list:smart_lists(id, name, color)')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })

  // Pipeline stages power the campaign builder's "target by stage" audience mode.
  const { data: stages } = await supabase
    .from('pipeline_stages')
    .select('id, name, slug, position')
    .eq('organization_id', orgId)
    .order('position', { ascending: true })

  // Flatten smart_list join for easier consumption
  const enriched = (campaigns || []).map((c: any) => ({
    ...c,
    smart_list_name: c.smart_list?.name || null,
    smart_list_color: c.smart_list?.color || null,
  }))

  return (
    <CampaignsList campaigns={enriched} initialSmartListId={smart_list_id} stages={stages || []} />
  )
}
