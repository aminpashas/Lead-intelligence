import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { LiveTransferSettings } from '@/components/crm/live-transfer-settings'

const ADMIN_ROLES = ['owner', 'admin', 'doctor_admin', 'office_manager', 'agency_admin']

export default async function LiveTransferSettingsPage() {
  const supabase = await createClient()

  // Effective org honors an agency_admin's entered client account; role gates the
  // admin-only controls (arming the feature, editing targets/routes).
  const { orgId, role } = await resolveActiveOrg(supabase)
  if (!orgId) return null

  const canAdmin = ADMIN_ROLES.includes(role || '')

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Live transfer</h1>
        <p className="text-sm text-muted-foreground">
          Let the AI dial leads in bulk and forward each answered call to a live person.
        </p>
      </div>
      <LiveTransferSettings canAdmin={canAdmin} />
    </div>
  )
}
