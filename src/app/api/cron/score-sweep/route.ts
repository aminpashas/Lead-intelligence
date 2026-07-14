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

import { withCron } from '@/lib/cron/with-cron'
import { rescoreAndPersistLead } from '@/lib/ai/scoring'
import type { Lead } from '@/types/database'

/** The sweep makes N Claude calls per run; give the function room. */
export const maxDuration = 300

const MAX_PER_RUN = Number(process.env.SCORE_SWEEP_MAX_PER_RUN) || 50
const MAX_PER_ORG = Number(process.env.SCORE_SWEEP_MAX_PER_ORG) || 25
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
        errors.push(`Lead ${lead.id}: ${err instanceof Error ? err.message : 'scoring failed'}`)
        // Stamp the attempt so an un-scoreable lead can't be re-selected every run.
        // Leaves ai_score/ai_qualification untouched (still reads as unscored in the
        // UI) — this only records "we tried", matching cron/enrich's failed-marking.
        await supabase
          .from('leads')
          .update({ ai_score_updated_at: new Date().toISOString() })
          .eq('id', lead.id)
      }
    }
  }

  return {
    items: scored,
    data: { scored, failed, per_org: perOrg, errors: errors.slice(0, 10) },
  }
})

export const GET = POST
