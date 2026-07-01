import { createClient } from '@/lib/supabase/server'
import { ReactivationCenter } from '@/components/crm/reactivation-center'
import { resolveActiveOrg } from '@/lib/auth/active-org'

export default async function ReactivationPage() {
  const supabase = await createClient()

  // Effective org honors an agency_admin's entered client account.
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return null

  const { data: campaigns } = await supabase
    .from('reactivation_campaigns')
    .select('*, offers:reactivation_offers(*)')
    .eq('organization_id', orgId)
    .neq('status', 'archived')
    .order('created_at', { ascending: false })

  return (
    <ReactivationCenter campaigns={campaigns || []} />
  )
}
