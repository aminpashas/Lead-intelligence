/**
 * /settings/connectors/meta/select
 *
 * Step 2 of the Meta OAuth flow. Renders the ad accounts the user just
 * authorized, grouped with their Pixels, and lets them pick which pair
 * to bind to this org's `meta_capi` connector.
 */

import { redirect } from 'next/navigation'
import { createServiceClient, createClient } from '@/lib/supabase/server'
import { MetaSelectForm } from './form'

type StateMetadata = {
  stage?: string
  token_expires_at?: string | null
  ad_accounts?: Array<{
    id: string
    accountId: string
    name?: string
    currency?: string
    timezoneName?: string
    accountStatus?: number
    businessName?: string
  }>
  ad_accounts_error?: string | null
  pixels_by_account?: Record<string, Array<{
    id: string
    name?: string
    lastFiredTime?: string
    adAccountId: string
  }>>
}

export default async function MetaSelectPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>
}) {
  const params = await searchParams
  const state = params.state

  if (!state) {
    redirect('/settings/connectors?oauth_error=missing_picker_state')
  }

  const userSupabase = await createClient()
  const { data: profile } = await userSupabase
    .from('user_profiles')
    .select('organization_id, role')
    .single()

  if (!profile || !['owner', 'admin'].includes(profile.role)) {
    redirect('/settings/connectors?oauth_error=forbidden')
  }

  const service = createServiceClient()
  const { data: stateRow } = await service
    .from('oauth_states')
    .select('state, organization_id, expires_at, metadata')
    .eq('state', state)
    .eq('provider', 'meta')
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
  const adAccounts = metadata.ad_accounts || []
  const pixelsByAccount = metadata.pixels_by_account || {}

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-2">Finish connecting Meta</h1>
        <p className="text-muted-foreground">
          Pick the ad account and Pixel you want CRM events sent to.
          {metadata.token_expires_at && (
            <>
              {' '}The access token expires{' '}
              <span className="font-medium">
                {new Date(metadata.token_expires_at).toLocaleDateString()}
              </span>
              {' '}— you&apos;ll be prompted to reconnect before then.
            </>
          )}
        </p>
      </div>

      <MetaSelectForm
        state={state}
        adAccounts={adAccounts}
        adAccountsError={metadata.ad_accounts_error ?? null}
        pixelsByAccount={pixelsByAccount}
      />
    </div>
  )
}
