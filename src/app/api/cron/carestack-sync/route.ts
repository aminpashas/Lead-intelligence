/**
 * CareStack incremental sync — daily.
 *
 * For every org with a CareStack connector configured, run the resource sync
 * runners in order:
 *   1. patients              (refresh bridge table)
 *   2. treatment_procedures  (emits lead.treatment_accepted / .completed)
 *   3. invoices              (emits lead.payment.received)
 *
 * Each runner is independently retryable and idempotent. The events emitted go
 * into the `events` table where the existing forward-events cron picks them up
 * and ships to Meta CAPI / Google Ads as Purchase / value-bearing conversions.
 *
 * Vercel cron: 30 04 * * * (04:30 UTC daily) — runs before forward-events
 * (every 2 min) so newly emitted events get one ship attempt within minutes.
 * Heartbeats to cron_runs via withCron.
 *
 * TIME BUDGET: this cron chains 6 paginated runners + 3 rollups in a single
 * invocation, each doing many awaited round-trips. Without a bound it exceeds
 * the Vercel function limit and is KILLED before returning — which means
 * withCron never records a cron_runs heartbeat (it records on success AND on
 * throw, but not on a hard kill) and the cursors only crawl forward. We now
 * cap the run to RUN_BUDGET_MS: every runner stops paginating at the deadline
 * (persisting its cursor as 'partial' so the next run resumes), and the later
 * runners/rollups are skipped once the budget is spent. The function then
 * returns cleanly and heartbeats. Remaining work is picked up on the next run.
 */

import { withCron } from '@/lib/cron/with-cron'
import { getCareStackConfig } from '@/lib/ehr/carestack/client'
import { syncPatients, syncTreatmentProcedures, syncInvoices, syncCareStackAppointments } from '@/lib/ehr/carestack/sync'
import { syncCareStackBusySlots } from '@/lib/ehr/carestack/busy-sync'
import { rollupLeadOutcomes, rollupConsultOutcomes } from '@/lib/ehr/carestack/rollup'
import { rematchUnlinkedPatients } from '@/lib/ehr/carestack/rematch'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Leave headroom below maxDuration for the final cursor writes + the withCron
// heartbeat, so the function RETURNS instead of being killed mid-run.
const RUN_BUDGET_MS = (maxDuration - 45) * 1000

export const POST = withCron('carestack-sync', async ({ supabase }) => {
  const deadlineAt = Date.now() + RUN_BUDGET_MS
  const overBudget = () => Date.now() >= deadlineAt

  // All orgs with a CareStack connector configured AND enabled.
  const { data: orgs } = await supabase
    .from('connector_configs')
    .select('organization_id')
    .eq('connector_type', 'carestack')
    .eq('enabled', true)

  if (!orgs || orgs.length === 0) {
    return { status: 'skipped', items: 0, data: { message: 'No CareStack integrations configured', orgs: 0 } }
  }

  const results: Array<{
    organization_id: string
    runs: Array<{
      resource: string
      fetched: number
      upserted: number
      events_emitted: number
      status: string
      error?: string
    }>
  }> = []

  let truncated = false

  for (const org of orgs as Array<{ organization_id: string }>) {
    if (overBudget()) { truncated = true; break }

    const config = await getCareStackConfig(supabase, org.organization_id)
    if (!config) {
      results.push({
        organization_id: org.organization_id,
        runs: [{ resource: 'config', fetched: 0, upserted: 0, events_emitted: 0, status: 'failed', error: 'config_invalid' }],
      })
      continue
    }

    const runs: Array<{ resource: string; fetched: number; upserted: number; events_emitted: number; status: string; error?: string }> = []

    // 1) Patients — refresh the bridge table first so subsequent runners
    //    can resolve patient → lead links via cached fields.
    runs.push(await syncPatients(supabase, org.organization_id, config, deadlineAt))

    // 2) Treatment procedures — emits the revenue-bearing events.
    if (!overBudget()) runs.push(await syncTreatmentProcedures(supabase, org.organization_id, config, deadlineAt))

    // 3) Invoices — emits actual collected revenue.
    if (!overBudget()) runs.push(await syncInvoices(supabase, org.organization_id, config, deadlineAt))

    // 4) Busy slots — mirror PMS occupancy so booking availability stays accurate.
    if (!overBudget()) runs.push(await syncCareStackBusySlots(supabase, org.organization_id, config, deadlineAt))

    // 4b) Appointments — pull the CareStack calendar so we can measure consult
    //     show / no-show. Feeds the consult rollup below.
    if (!overBudget()) runs.push(await syncCareStackAppointments(supabase, org.organization_id, config, deadlineAt))

    // 5) Re-match sweep — link already-synced patients back to leads (most
    //    synced before their lead was hashed, so lead_id sits null). Must run
    //    before the rollup so newly-linked patients get their $ rolled up.
    if (!overBudget()) {
      const rematch = await rematchUnlinkedPatients(supabase, org.organization_id)
      runs.push({
        resource: rematch.resource,
        fetched: rematch.patients_scanned,
        upserted: rematch.newly_matched,
        events_emitted: 0,
        status: rematch.status,
        error: rematch.error,
      })
    }

    // 6) Roll accepted/completed procedure $ up onto the matched leads so
    //    dashboards (goals/actuals) and Google/Meta offline conversions read a
    //    real treatment_value / actual_revenue instead of null.
    if (!overBudget()) {
      const rollup = await rollupLeadOutcomes(supabase, org.organization_id)
      runs.push({
        resource: rollup.resource,
        fetched: rollup.leads_examined,
        upserted: rollup.leads_updated,
        events_emitted: 0,
        status: rollup.status,
        error: rollup.error,
      })
    }

    // 7) Consult rollup — appointment show / no-show / consult dates onto leads.
    if (!overBudget()) {
      const consult = await rollupConsultOutcomes(supabase, org.organization_id)
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
    results.push({ organization_id: org.organization_id, runs })
  }

  return { items: results.length, data: { orgs: results.length, truncated, results } }
})

export const GET = POST
