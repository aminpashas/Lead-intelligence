import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { getOrgFlags, flagOn } from '@/lib/org/flags'
import { hasPermission } from '@/lib/auth/permissions'
import { FinancingPrequalSettings } from '@/components/settings/financing-prequal-settings'
import { FinancingLendersSettings } from '@/components/settings/financing-lenders-settings'

/**
 * Settings → Financing. The account-level home for the pre-qualification
 * feature: the master on/off (which lights up the per-lead "Send Pre-Qual"
 * button), the separate "let the AI send it automatically" switch, and lender
 * configuration underneath.
 *
 * Viewable with `ai_control:read` (practice admins + agency); writes are gated
 * to `ai_control:write` (agency), enforced in POST /api/settings/financing.
 */
export default async function FinancingSettingsPage() {
  const supabase = await createClient()

  const { orgId, role } = await resolveActiveOrg(supabase)
  if (!orgId) return null

  const flags = await getOrgFlags(supabase, orgId)
  const canWrite = hasPermission(role || '', 'ai_control:write')

  return (
    <div className="mx-auto max-w-3xl space-y-6 py-6">
      <div>
        <h1 className="text-lg font-semibold text-aurea-ink">Financing</h1>
        <p className="text-sm text-aurea-ink-3">
          Control patient pre-qualification and how financing links are sent.
        </p>
      </div>

      <FinancingPrequalSettings
        initialPrequalEnabled={flagOn(flags, 'financing_prequal_enabled')}
        initialAutoSendEnabled={flagOn(flags, 'financing_auto_send_enabled')}
        canWrite={canWrite}
      />

      <FinancingLendersSettings />
    </div>
  )
}
