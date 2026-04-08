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
    .select('*, steps:campaign_steps(count), enrollments:campaign_enrollments(count)')
    .eq('organization_id', profile.organization_id)
    .order('created_at', { ascending: false })

  return (
    <CampaignsList campaigns={campaigns || []} />
  )
}
