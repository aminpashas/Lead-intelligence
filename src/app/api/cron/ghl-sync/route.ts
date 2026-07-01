/**
 * GoHighLevel → Lead Intelligence incremental sync — every 15 minutes.
 *
 * For every org with a GHL connector configured AND enabled, pull the
 * location's opportunities into LI leads (idempotent + incremental). Each org
 * is isolated: one org's failure is recorded and the loop continues.
 *
 * Vercel cron: every 15 min. Heartbeats to cron_runs via withCron.
 */

import { withCron } from '@/lib/cron/with-cron'
import { getGhlConfig } from '@/lib/ghl/client'
import { syncGhlLeads } from '@/lib/ghl/sync'
import type { GhlSyncResult } from '@/lib/ghl/types'

type OrgRunResult =
  | ({ organization_id: string } & GhlSyncResult)
  | { organization_id: string; status: 'failed'; error: string }

export const POST = withCron('ghl-sync', async ({ supabase }) => {
  const { data: orgs } = await supabase
    .from('connector_configs')
    .select('organization_id')
    .eq('connector_type', 'ghl')
    .eq('enabled', true)

  if (!orgs || orgs.length === 0) {
    return { status: 'skipped', items: 0, data: { message: 'No GHL integrations configured', orgs: 0 } }
  }

  const results: OrgRunResult[] = []

  for (const org of orgs as Array<{ organization_id: string }>) {
    const config = await getGhlConfig(supabase, org.organization_id)
    if (!config) {
      results.push({ organization_id: org.organization_id, status: 'failed', error: 'config_invalid' })
      continue
    }
    try {
      const r = await syncGhlLeads(supabase, org.organization_id, config)
      results.push({ organization_id: org.organization_id, ...r })
    } catch (err) {
      results.push({
        organization_id: org.organization_id,
        status: 'failed',
        error: err instanceof Error ? err.message : 'sync_failed',
      })
    }
  }

  const items = results.reduce((n, r) => n + ('inserted' in r ? r.inserted : 0), 0)
  return { items, data: { orgs: results.length, results } }
})

export const GET = POST
