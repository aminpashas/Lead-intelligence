/**
 * /settings/connectors/google/select
 *
 * Second step of the Google OAuth flow. After the user consents in Google
 * and we enumerate their accessible Ads customers + GA4 properties, they
 * land here to pick which accounts to bind. Submit POSTs to the
 * `/select` API route which promotes the choices into connector_configs.
 *
 * Server-component: reads the pending oauth_state row by the `state`
 * query param, unpacks the discovery payload, and hands it to the
 * client-side form.
 */

import { redirect } from 'next/navigation'
import { createServiceClient } from '@/lib/supabase/server'
import { createClient } from '@/lib/supabase/server'
import { GoogleSelectForm } from './form'

type StateMetadata = {
  stage?: string
  ads_customers?: Array<{
    customerId: string
    descriptiveName?: string
    currencyCode?: string
    timeZone?: string
    manager?: boolean
  }>
  ads_error?: string | null
  ga4_accounts?: Array<{
    account: string
    accountDisplay: string
    propertySummaries: Array<{
      property: string
      propertyId: string
      displayName: string
    }>
  }>
  ga4_error?: string | null
}

export default async function GoogleSelectPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>
}) {
  const params = await searchParams
  const state = params.state

  if (!state) {
    redirect('/settings/connectors?oauth_error=missing_picker_state')
  }

  // Auth gate — the picker is behind (dashboard) layout already, but we
  // also need the user's org to verify the state row belongs to them.
  const userSupabase = await createClient()
  const { data: profile } = await userSupabase
    .from('user_profiles')
    .select('organization_id, role')
    .single()

  if (!profile || !['owner', 'admin'].includes(profile.role)) {
    redirect('/settings/connectors?oauth_error=forbidden')
  }

  // Service client bypasses RLS for the state lookup. We verify org
  // membership manually below.
  const service = createServiceClient()
  const { data: stateRow } = await service
    .from('oauth_states')
    .select('state, organization_id, user_id, expires_at, metadata')
    .eq('state', state)
    .eq('provider', 'google')
    .maybeSingle()

  if (!stateRow) {
    redirect('/settings/connectors?oauth_error=invalid_or_consumed_state')
  }
  if (stateRow.organization_id !== profile.organization_id) {
    redirect('/settings/connectors?oauth_error=state_org_mismatch')
  }
  if (new Date(stateRow.expires_at).getTime() < Date.now()) {
    redirect('/settings/connectors?oauth_error=state_expired')
  }

  const metadata = (stateRow.metadata || {}) as StateMetadata
  const adsCustomers = metadata.ads_customers || []
  const ga4Accounts = metadata.ga4_accounts || []

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-2">Finish connecting Google</h1>
        <p className="text-muted-foreground">
          Pick which Google Ads account and GA4 property to bind to your organization.
          You can reconnect later to change these.
        </p>
      </div>

      <GoogleSelectForm
        state={state}
        adsCustomers={adsCustomers}
        adsError={metadata.ads_error ?? null}
        ga4Accounts={ga4Accounts}
        ga4Error={metadata.ga4_error ?? null}
      />
    </div>
  )
}
