import { createClient } from '@/lib/supabase/server'
import { ReactivationCenter } from '@/components/crm/reactivation-center'

export default async function ReactivationPage() {
  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) return null

  const { data: campaigns } = await supabase
    .from('reactivation_campaigns')
    .select('*, offers:reactivation_offers(*)')
    .eq('organization_id', profile.organization_id)
    .neq('status', 'archived')
    .order('created_at', { ascending: false })

  return (
    <ReactivationCenter campaigns={campaigns || []} />
  )
}
