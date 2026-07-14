/**
 * Background AI score-sweep — grades leads the inline hot path never touched.
 *
 * AI scoring (`rescoreAndPersistLead`) only runs inline at real-time ad/form
 * webhook ingestion (form, meta, google-ads, qualify) and on manual re-grade.
 * Leads that enter through any OTHER door — GHL pull sync, CSV/GHL import,
 * WhatConverts backfill, the DGS bridge — are created WITHOUT a score and nothing
 * ever catches them up. For a practice whose volume is overwhelmingly bulk-sourced
 * that means `ai_score` is absent across the pipeline, dialer, and smart lists.
 *
 * This cron drains that backlog in capped, budgeted batches and self-heals every
 * future bulk import: each run scores the newest unscored, non-terminal leads
 * (freshest-first, matching the dialer's queue priority), one Claude call each.
 *
 * "Never scored" = `ai_score_updated_at IS NULL` — the timestamp every scoring
 * write (inline webhooks + rescoreAndPersistLead) stamps. On a per-lead failure we
 * stamp it anyway so a lead with un-scoreable data can't be re-attempted forever
 * (same forward-progress discipline as cron/enrich's failed-marking).
 *
 * Scoping: scoring feeds the whole app, not just voice, so this is NOT gated on the
 * dialer's compliance filter — but terminal leads (lost/disqualified/completed) are
 * skipped so spend isn't burned on dead records.
 *
 * Kill switch: set SCORE_SWEEP_DISABLED=true to pause without a redeploy.
 * Tunables: SCORE_SWEEP_MAX_PER_RUN (default 50), SCORE_SWEEP_MAX_PER_ORG (25).
 */

import Anthropic from '@anthropic-ai/sdk'
import { withCron } from '@/lib/cron/with-cron'
import { rescoreAndPersistLead } from '@/lib/ai/scoring'
import type { Lead } from '@/types/database'

/** The sweep makes N sequential Claude calls per run; give the function room.
 *  800s (Vercel Pro ceiling) fits ~200 leads/run at ~2-3s each — sized to drain
 *  the scoring backlog in ~2-3 days rather than ~18 at the old 25/run cap. */
export const maxDuration = 800

// ~200 leads/run fits the 800s maxDuration (each lead is a sequential ~2-3s
// Claude call). At batch-15m's 15-min cadence that's ~19k/day → the ~43k
// scoring backlog drains in ~2-3 days. A timeout mid-run is harmless — each lead
// commits independently and unprocessed leads simply retry next tick (never
// stamped/burned). Env-overridable; drop back toward 25-50 once the backlog
// clears if steady-state per-tick cost matters.
const MAX_PER_RUN = Number(process.env.SCORE_SWEEP_MAX_PER_RUN) || 200
const MAX_PER_ORG = Number(process.env.SCORE_SWEEP_MAX_PER_ORG) || 200
const TERMINAL_STATUSES = '(lost,disqualified,completed)'

export const POST = withCron('score-sweep', async ({ supabase }) => {
  if (process.env.SCORE_SWEEP_DISABLED === 'true') {
    return { status: 'skipped', items: 0, data: { message: 'SCORE_SWEEP_DISABLED' } }
  }

  const { data: orgs } = await supabase.from('organizations').select('id')
  if (!orgs || orgs.length === 0) {
    return { status: 'skipped', items: 0, data: { message: 'No organizations' } }
  }

  let scored = 0
  let failed = 0
  const errors: string[] = []
  const perOrg: Record<string, number> = {}
  // Set when a systemic API failure (out of credits, auth, rate limit, 5xx,
  // network) is hit — aborts the run so an outage can't burn the whole backlog.
  let apiOutage: string | null = null

  for (const org of orgs as Array<{ id: string }>) {
    if (scored >= MAX_PER_RUN) break

    // Newest unscored, non-terminal leads first — mirrors the dialer's freshest-first
    // queue so the leads a rep is most likely to work get graded soonest.
    const { data: leads, error: fetchError } = await supabase
      .from('leads')
      .select('*')
      .eq('organization_id', org.id)
      .is('ai_score_updated_at', null)
      .not('status', 'in', TERMINAL_STATUSES)
      .order('created_at', { ascending: false })
      .limit(Math.min(MAX_PER_ORG, MAX_PER_RUN - scored))

    // Don't swallow a fetch error: PostgREST returns `{ data: null, error }` on a
    // rejected query, and a bare `const { data }` made that indistinguishable from
    // "no unscored leads" — the sweep would heartbeat `items:0, ok` every run while
    // a real backlog sat untouched. Surface it so the heartbeat's `error` column
    // shows the actual cause instead of a silent no-op.
    if (fetchError) {
      failed++
      errors.push(`Org ${org.id}: lead fetch failed: ${fetchError.message}`)
      continue
    }

    if (!leads || leads.length === 0) continue

    for (const lead of leads as Lead[]) {
      if (scored >= MAX_PER_RUN) break
      try {
        await rescoreAndPersistLead(supabase, lead)
        scored++
        perOrg[org.id] = (perOrg[org.id] ?? 0) + 1
      } catch (err) {
        failed++
        const msg = err instanceof Error ? err.message : 'scoring failed'
        errors.push(`Lead ${lead.id}: ${msg}`)
        // A systemic API failure (out of credits, auth, rate limit, 5xx, network)
        // is not the lead's fault. Do NOT stamp ai_score_updated_at — that would
        // permanently exclude the lead from every future sweep — and abort the run
        // so one outage can't burn the whole backlog into a never-retried state.
        if (err instanceof Anthropic.APIError) {
          apiOutage = msg
          break
        }
        // Genuine per-lead failure (e.g. unparseable data): stamp the attempt so an
        // un-scoreable lead can't be re-selected every run. Leaves ai_score untouched
        // (still reads as unscored in the UI) — matches cron/enrich's failed-marking.
        await supabase
          .from('leads')
          .update({ ai_score_updated_at: new Date().toISOString() })
          .eq('id', lead.id)
      }
    }
    if (apiOutage) break
  }

  return {
    status: apiOutage ? ('failed' as const) : undefined,
    error: apiOutage ?? undefined,
    items: scored,
    data: { scored, failed, per_org: perOrg, errors: errors.slice(0, 10), api_outage: apiOutage },
  }
})

export const GET = POST
