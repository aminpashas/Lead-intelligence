/**
 * Background enrichment for leads missing enrichment data. Runs every 15 min via
 * the batch-15m fan-out.
 *
 * Now instrumented with withCron. It previously hand-rolled its auth and wrote no
 * cron_runs row, so it had no heartbeat at all — an empty cron_runs for `enrich`
 * read as "never ran" when it actually meant "never instrumented". That blind
 * spot hid an 8-day outage: zero lead_enrichment rows were created anywhere
 * between 2026-07-12 and 2026-07-19 while the route returned HTTP 200 every tick.
 *
 * `items` counts enrichment ROWS ACTUALLY CREATED, not leads attempted. The old
 * counter incremented once per lead regardless of whether enrichLead produced
 * anything, so a run in which every provider was budget-disabled, uncredentialed,
 * or already-fresh still reported `enriched: 40`. A metric that reports success
 * when nothing happened is precisely how the outage stayed invisible.
 */
import { withCron } from '@/lib/cron/with-cron'
import { enrichLead } from '@/lib/enrichment'
import {
  budgetConfigOverride,
  getMonthlyEnrichmentCounts,
  overBudgetTypes,
  resolveMonthlyBudgets,
} from '@/lib/enrichment/budgets'

const MAX_LEADS_PER_RUN = 50
const MAX_LEADS_PER_ORG = 10

export const POST = withCron('enrich', async ({ supabase }) => {
  const runStart = new Date().toISOString()

  const { data: orgs } = await supabase.from('organizations').select('id')
  if (!orgs || orgs.length === 0) {
    return { status: 'skipped' as const, items: 0, data: { message: 'No organizations' } }
  }

  let attempted = 0
  let totalFailed = 0
  const errors: string[] = []
  const budgets = resolveMonthlyBudgets()
  const budgetSkips: Record<string, string[]> = {}

  for (const org of orgs as Array<{ id: string }>) {
    if (attempted >= MAX_LEADS_PER_RUN) break

    // Find leads that need enrichment: have email or phone, status pending/partial
    const { data: leads } = await supabase
      .from('leads')
      .select('*')
      .eq('organization_id', org.id)
      .in('enrichment_status', ['pending', 'partial'])
      .or('email.not.is.null,phone.not.is.null')
      .order('created_at', { ascending: false })
      .limit(Math.min(MAX_LEADS_PER_ORG, MAX_LEADS_PER_RUN - attempted))

    if (!leads || leads.length === 0) continue

    // Per-provider monthly budgets: disable any provider that already created
    // its budgeted number of rows for this org this calendar month.
    const counts = await getMonthlyEnrichmentCounts(supabase, org.id)
    const exceeded = overBudgetTypes(counts, budgets)
    const configOverride = budgetConfigOverride(exceeded)
    if (exceeded.length > 0) {
      budgetSkips[org.id] = exceeded
      console.warn(
        `[cron/enrich] org ${org.id}: monthly budget reached for ${exceeded.join(', ')} — skipping those providers`,
        { counts, budgets }
      )
    }

    for (const lead of leads) {
      attempted++
      try {
        await enrichLead(supabase, lead, configOverride)
      } catch (err) {
        totalFailed++
        errors.push(`Lead ${lead.id}: ${err instanceof Error ? err.message : 'Unknown error'}`)

        // Mark as failed so we don't retry endlessly
        await supabase.from('leads').update({ enrichment_status: 'failed' }).eq('id', lead.id)
      }
    }
  }

  // Ground truth: how many rows this run actually landed. enrichLead skips
  // silently when a provider is disabled, budget-exhausted, uncredentialed, or
  // already fresh for the lead — so "we called it" is not evidence of anything.
  const { count } = await supabase
    .from('lead_enrichment')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', runStart)

  const rowsCreated = count ?? 0
  const skipped = [...new Set(Object.values(budgetSkips).flat())]

  // Attempted work that produced nothing is the outage signature. Surface it on
  // the heartbeat instead of reporting a healthy-looking `ok`.
  const barren = attempted > 0 && rowsCreated === 0
  const barrenNote = barren
    ? `enriched 0 rows from ${attempted} attempted leads` +
      (skipped.length ? ` (over monthly budget: ${skipped.join(', ')})` : '')
    : undefined

  return {
    status: (totalFailed > 0 || barren ? 'failed' : 'ok') as 'failed' | 'ok',
    items: rowsCreated,
    error: barrenNote ?? errors[0],
    data: {
      rows_created: rowsCreated,
      leads_attempted: attempted,
      failed: totalFailed,
      errors: errors.slice(0, 10),
      budget_skips: budgetSkips,
    },
  }
})

// Vercel Cron invokes cron routes with GET; alias so the schedule actually runs.
export const GET = POST
