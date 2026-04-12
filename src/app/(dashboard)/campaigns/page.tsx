import { createClient } from '@/lib/supabase/server'
import { CampaignsList } from '@/components/crm/campaigns-list'

export default async function CampaignsPage() {
  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) return null

  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('*, steps:campaign_steps(count), enrollments:campaign_enrollments(count), smart_list:smart_lists(id, name, color)')
    .eq('organization_id', profile.organization_id)
    .order('created_at', { ascending: false })

  // Flatten smart_list join for easier consumption
  const enriched = (campaigns || []).map((c: any) => ({
    ...c,
    smart_list_name: c.smart_list?.name || null,
    smart_list_color: c.smart_list?.color || null,
  }))

  return (
    <CampaignsList campaigns={enriched} />
  )
}
