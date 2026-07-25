/**
 * EHR incremental pull — daily, across every configured EMR.
 *
 * Was `carestack-sync`, which hardcoded the CareStack runners. It now loops
 * org × adapter through the EhrAdapter port, so a second EMR is picked up with
 * no change to this file. Each adapter owns the order of its own runners
 * (CareStack must refresh patients before procedures); the rollups afterwards
 * are vendor-neutral and run once per org over whatever every adapter wrote.
 *
 * The events emitted by the runners go into the `events` table where the
 * existing forward-events cron picks them up and ships to Meta CAPI / Google Ads
 * as Purchase / value-bearing conversions.
 *
 * Vercel cron: 30 04 * * * (04:30 UTC daily) — runs before forward-events
 * (every 2 min) so newly emitted events get one ship attempt within minutes.
 * Heartbeats to cron_runs via withCron.
 *
 * TIME BUDGET: this cron chains many paginated runners + 2 rollups in a single
 * invocation, each doing many awaited round-trips. Without a bound it exceeds
 * the Vercel function limit and is KILLED before returning — which means
 * withCron never records a cron_runs heartbeat (it records on success AND on
 * throw, but not on a hard kill) and the cursors only crawl forward. We cap the
 * run to RUN_BUDGET_MS: every runner stops paginating at the deadline
 * (persisting its cursor as 'partial' so the next run resumes), and the later
 * adapters/rollups are skipped once the budget is spent. The function then
 * returns cleanly and heartbeats. Remaining work is picked up on the next run.
 *
 * With more than one adapter per org this budget matters MORE, not less — the
 * deadline is threaded into every adapter via EhrCtx.deadlineAt.
 */

import { withCron } from '@/lib/cron/with-cron'
import { getEnabledAdapters, EHR_CONNECTOR_TYPES } from '@/lib/ehr/registry'
import { rollupLeadOutcomes, rollupConsultOutcomes } from '@/lib/ehr/rollup'
import type { SyncRun } from '@/lib/ehr/port'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Leave headroom below maxDuration for the final cursor writes + the withCron
// heartbeat, so the function RETURNS instead of being killed mid-run.
const RUN_BUDGET_MS = (maxDuration - 45) * 1000

export const POST = withCron('ehr-daily-sync', async ({ supabase }) => {
  const deadlineAt = Date.now() + RUN_BUDGET_MS
  const overBudget = () => Date.now() >= deadlineAt

  // Every org with any EHR connector configured AND enabled.
  const { data: rows } = await supabase
    .from('connector_configs')
    .select('organization_id')
    .in('connector_type', EHR_CONNECTOR_TYPES)
    .eq('enabled', true)

  const orgRows = (rows ?? []) as Array<{ organization_id: string }>
  const orgIds: string[] = [...new Set(orgRows.map((r) => r.organization_id))]

  if (orgIds.length === 0) {
    return { status: 'skipped', items: 0, data: { message: 'No EHR integrations configured', orgs: 0 } }
  }

  const results: Array<{ organization_id: string; runs: SyncRun[] }> = []
  let truncated = false

  for (const organizationId of orgIds) {
    if (overBudget()) { truncated = true; break }

    const runs: SyncRun[] = []
    const adapters = await getEnabledAdapters(supabase, organizationId)

    if (adapters.length === 0) {
      // Row exists in connector_configs but the config didn't resolve (missing
      // credentials, or a connector_type with no registered adapter).
      runs.push({ resource: 'config', fetched: 0, upserted: 0, events_emitted: 0, status: 'failed', error: 'config_invalid' })
      results.push({ organization_id: organizationId, runs })
      continue
    }

    // ── Pull side: each adapter's runners, in the adapter's own order ──
    for (const { adapter, config } of adapters) {
      if (overBudget()) { truncated = true; break }
      try {
        const adapterRuns = await adapter.runSync({ supabase, organizationId, config, deadlineAt })
        runs.push(...adapterRuns.map((r) => ({ ...r, resource: `${adapter.source}:${r.resource}` })))
      } catch (err) {
        // A runner throwing (rather than returning a failed SyncRun) must not
        // stop the other adapters or the rollups.
        runs.push({
          resource: `${adapter.source}:runSync`,
          fetched: 0,
          upserted: 0,
          events_emitted: 0,
          status: 'failed',
          error: err instanceof Error ? err.message : 'adapter error',
        })
      }
    }

    // ── Rollups: vendor-neutral, once per org, over every adapter's rows ──
    // Roll accepted/completed procedure $ up onto the matched leads so dashboards
    // (goals/actuals) and Google/Meta offline conversions read a real
    // treatment_value / actual_revenue instead of null.
    if (!overBudget()) {
      const rollup = await rollupLeadOutcomes(supabase, organizationId)
      runs.push({
        resource: rollup.resource,
        fetched: rollup.leads_examined,
        upserted: rollup.leads_updated,
        events_emitted: 0,
        status: rollup.status,
        error: rollup.error,
      })
    }

    // Consult rollup — appointment show / no-show / consult dates onto leads.
    if (!overBudget()) {
      const consult = await rollupConsultOutcomes(supabase, organizationId)
      runs.push({
        resource: consult.resource,
        fetched: consult.leads_examined,
        upserted: consult.leads_updated,
        events_emitted: 0,
        status: consult.status,
        error: consult.error,
      })
    }

    if (overBudget()) truncated = true
    results.push({ organization_id: organizationId, runs })
  }

  return { items: results.length, data: { orgs: results.length, truncated, results } }
})

export const GET = POST
