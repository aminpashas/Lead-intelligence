/**
 * Brex daily expense sync.
 * Vercel cron: 06:00 UTC daily (after Windsor at 05:00). Heartbeats via withCron.
 */

import { withCron } from '@/lib/cron/with-cron'
import { getBrexConfig, runBrexSync } from '@/lib/connectors/brex/client'

export const POST = withCron('brex-sync', async ({ supabase }) => {
  const { data: orgs } = await supabase
    .from('connector_configs')
    .select('organization_id')
    .eq('connector_type', 'brex')
    .eq('enabled', true)

  if (!orgs || orgs.length === 0) {
    return { status: 'skipped', items: 0, data: { message: 'No Brex connectors configured', orgs: 0 } }
  }

  const results: Array<{ organization_id: string; result: unknown }> = []

  for (const org of orgs as Array<{ organization_id: string }>) {
    const config = await getBrexConfig(supabase, org.organization_id)
    if (!config) {
      results.push({ organization_id: org.organization_id, result: { error: 'config_invalid' } })
      continue
    }
    const result = await runBrexSync(supabase, org.organization_id, config)
    results.push({ organization_id: org.organization_id, result })
  }

  return { items: results.length, data: { orgs: results.length, results } }
})

export const GET = POST
