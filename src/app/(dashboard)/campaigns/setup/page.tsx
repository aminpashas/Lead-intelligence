import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { isAdminRole } from '@/lib/auth/permissions'
import { CampaignSetup } from '@/components/crm/campaign-setup'

/**
 * Campaign setup — pick a service line, run the AI onboarding interview, and
 * launch its blueprint campaign once the required-answer checklist is green.
 */
export default async function CampaignSetupPage() {
  const supabase = await createClient()
  const { orgId, role } = await resolveActiveOrg(supabase)
  if (!orgId || !role) return null

  return (
    <CampaignSetup
      isAdmin={isAdminRole(role)}
      isAgencyAdmin={role === 'agency_admin'}
    />
  )
}
