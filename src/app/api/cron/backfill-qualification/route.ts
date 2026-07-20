/**
 * Qualification backfill — mine existing conversations for the clinical/financial
 * facts the live setter agent would have captured.
 *
 * 42,202 of 42,204 SF Dentistry leads that have a conversation are missing BOTH
 * dental_condition and financing_interest — together 40% of the weighted scoring
 * model (0.22 + 0.18), all pinned at their "no data available" floor. The facts
 * are frequently sitting in the thread; nothing ever read them out, because
 * `captureQualificationFromResponse` only runs inside the live setter and these
 * threads arrived via the GHL import.
 *
 * Cost shape: scan wide, spend narrow. Measured yield splits hard by thread
 * length — <4-message threads yielded nothing at all, ≥8-message threads hit
 * ~75%. So each run scans up to MAX_SCAN candidates but only spends an LLM call
 * on threads long enough to be worth it (the extractor self-gates on
 * MIN_MESSAGES and returns null without calling the model). Every scanned lead is
 * stamped either way, so barren threads are retired cheaply and permanently
 * instead of being re-paid for every run.
 *
 * Writes go through `captureQualificationFromResponse`, unchanged — it validates
 * against the enums, refuses to overwrite existing form-supplied data, and
 * re-scores the lead so the new signals actually move ai_score.
 *
 * Kill switch: QUALIFICATION_BACKFILL_DISABLED=true (env, no deploy).
 * Tunables: QUALIFICATION_BACKFILL_MAX_SCAN, QUALIFICATION_BACKFILL_MAX_EXTRACT.
 */
import Anthropic from '@anthropic-ai/sdk'
import { withCron } from '@/lib/cron/with-cron'
import { extractQualificationFromTranscript } from '@/lib/ai/qualification-extract'
import { captureQualificationFromResponse } from '@/lib/ai/qualification-capture'
import type { Lead } from '@/types/database'

export const maxDuration = 800

// Scanning is one indexed query per lead; extracting is a Haiku call plus (on a
// hit) a Sonnet re-score. The scan cap drains the 42k backlog in ~40 runs while
// the extract cap bounds spend per tick.
const MAX_SCAN = Number(process.env.QUALIFICATION_BACKFILL_MAX_SCAN) || 1000
const MAX_EXTRACT = Number(process.env.QUALIFICATION_BACKFILL_MAX_EXTRACT) || 150

/** Below this, measured yield was zero — not worth a model call. */
const MIN_MESSAGES = 8

export const POST = withCron('backfill-qualification', async ({ supabase }) => {
  if (process.env.QUALIFICATION_BACKFILL_DISABLED === 'true') {
    return { status: 'skipped', items: 0, data: { message: 'QUALIFICATION_BACKFILL_DISABLED' } }
  }

  const { data: orgs } = await supabase.from('organizations').select('id')
  if (!orgs || orgs.length === 0) {
    return { status: 'skipped', items: 0, data: { message: 'No organizations' } }
  }

  let scanned = 0
  let extracted = 0
  let captured = 0
  let failed = 0
  const errors: string[] = []
  let apiOutage: string | null = null

  for (const org of orgs as Array<{ id: string }>) {
    if (scanned >= MAX_SCAN || extracted >= MAX_EXTRACT) break

    // Matches idx_leads_qualification_backfill_pending. Most-recent-reply first,
    // same priority order as score-sweep's engaged tier: a lead who replied last
    // week is worth learning about before one who replied last year.
    const { data: leads, error: fetchError } = await supabase
      .from('leads')
      .select('*')
      .eq('organization_id', org.id)
      .is('qualification_backfilled_at', null)
      .is('dental_condition', null)
      .not('last_responded_at', 'is', null)
      .order('last_responded_at', { ascending: false })
      .limit(Math.min(MAX_SCAN - scanned, 500))

    if (fetchError) {
      failed++
      errors.push(`Org ${org.id}: lead fetch failed: ${fetchError.message}`)
      continue
    }
    if (!leads || leads.length === 0) continue

    for (const lead of leads as Lead[]) {
      if (scanned >= MAX_SCAN || extracted >= MAX_EXTRACT) break
      scanned++

      try {
        const facts = await extractQualificationFromTranscript(supabase, lead.id, {
          minMessages: MIN_MESSAGES,
        })

        // null = thread too short (no model call was made) or nothing found.
        // Either way this lead is done: stamp and move on.
        if (facts) {
          extracted++
          await captureQualificationFromResponse(supabase, {
            lead,
            organization_id: org.id,
            captured: facts,
          })
          captured++
        }

        await supabase
          .from('leads')
          .update({ qualification_backfilled_at: new Date().toISOString() })
          .eq('id', lead.id)
      } catch (err) {
        failed++
        const msg = err instanceof Error ? err.message : 'backfill failed'
        errors.push(`Lead ${lead.id}: ${msg}`)
        // Systemic API failure — abort WITHOUT stamping, exactly as score-sweep
        // does, so an outage can't retire the backlog into a never-retried state.
        if (err instanceof Anthropic.APIError) {
          apiOutage = msg
          break
        }
        // Per-lead failure: stamp so one bad thread can't wedge the queue.
        await supabase
          .from('leads')
          .update({ qualification_backfilled_at: new Date().toISOString() })
          .eq('id', lead.id)
      }
    }
    if (apiOutage) break
  }

  return {
    status: apiOutage ? ('failed' as const) : undefined,
    error: apiOutage ?? undefined,
    items: captured,
    data: { scanned, extracted, captured, failed, errors: errors.slice(0, 10) },
  }
})
