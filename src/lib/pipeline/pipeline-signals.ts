import type { SupabaseClient } from '@supabase/supabase-js'
import type { PipelineStage } from '@/types/database'
import { isOperationalStage } from './stage-groups'
import { evEligibleSignals } from './recommendations'
import type { PipelineSignals, SegmentEv, SignalEvKey, StageSignal } from './recommendations'

/**
 * Gathers the aggregate signals the recommendations engine reads. Everything is
 * a bounded `head: true` COUNT query (no rows returned), so this scales to a
 * whole practice book cheaply. Counts are computed with the SAME predicates the
 * engine's `SmartListCriteria` produce, so each recommendation's displayed count
 * equals the segment "Apply" resolves — no bait-and-switch.
 *
 * SMS reachability mirrors `applySmartListCriteria` (has_phone + sms_consent):
 *   phone_formatted IS NOT NULL AND sms_consent = true AND sms_opt_out = false
 */

const STALE_DAYS = 7

/** TS signal key → `pipeline_segment_ev` p_signal value. The SQL predicates
 *  for each mirror the count queries below — keep both in lockstep. */
const SIGNAL_TO_RPC: Record<SignalEvKey, string> = {
  staleReachableSms: 'stale_reachable_sms',
  hotWarmReachableSms: 'hot_warm_reachable_sms',
  neverContacted: 'never_contacted',
  readyToBook: 'ready_to_book',
  deliberatingDue: 'deliberating_due',
}

/** One `pipeline_segment_ev` call, degraded to null on ANY failure (missing
 *  migration, RLS mismatch, transient error) so the pipeline page never breaks
 *  when the dollar layer is unavailable. */
async function fetchSegmentEv(
  supabase: SupabaseClient,
  orgId: string,
  stage: StageSignal,
  key: SignalEvKey,
  nowIso: string
): Promise<SegmentEv | null> {
  try {
    const { data, error } = await supabase.rpc('pipeline_segment_ev', {
      p_org_id: orgId,
      p_stage_id: stage.stageId,
      p_signal: SIGNAL_TO_RPC[key],
      p_now: nowIso,
    })
    if (error) throw new Error(error.message)
    // RETURNS TABLE → a single-row array; numerics arrive as strings.
    const row = (Array.isArray(data) ? data[0] : data) as
      | { lead_count?: unknown; expected_value?: unknown; avg_close_probability?: unknown }
      | undefined
    if (!row) return null
    return {
      leadCount: Number(row.lead_count ?? 0),
      expectedValueUsd: Number(row.expected_value ?? 0),
      avgCloseProbability: Number(row.avg_close_probability ?? 0),
    }
  } catch (e) {
    console.warn(
      `[pipeline-signals] EV unavailable for ${stage.stageName}/${key}:`,
      e instanceof Error ? e.message : e
    )
    return null
  }
}

/** Apply the shared SMS-reachability predicate to a leads count query. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function reachableSms(q: any) {
  return q
    .not('phone_formatted', 'is', null)
    .eq('sms_consent', true)
    .eq('sms_opt_out', false)
}

export async function gatherPipelineSignals(
  supabase: SupabaseClient,
  orgId: string,
  stages: PipelineStage[],
  serviceOr: string | null,
  nowMs: number
): Promise<PipelineSignals> {
  const staleCutoffIso = new Date(nowMs - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const nowIso = new Date(nowMs).toISOString()

  // One row of counts per stage. Each stage fires its counts in parallel; the
  // outer Promise.all fans out across stages too.
  const stageSignals = await Promise.all(
    stages.map(async (s): Promise<StageSignal> => {
      const kind = isOperationalStage(s.slug) ? 'operational' : 'sales'
      const base = () => {
        let q = supabase
          .from('leads')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', orgId)
          .eq('stage_id', s.id)
        if (serviceOr) q = q.or(serviceOr)
        return q
      }

      const [staleRes, hotRes, neverRes, readyRes, deliberatingDueRes] = await Promise.all([
        // Stale & SMS-reachable: never contacted OR contacted before the cutoff.
        reachableSms(base()).or(
          `last_contacted_at.is.null,last_contacted_at.lt.${staleCutoffIso}`
        ),
        // Hot/warm & SMS-reachable.
        reachableSms(base()).in('ai_qualification', ['hot', 'warm']),
        // Never contacted & SMS-reachable.
        reachableSms(base()).is('last_contacted_at', null),
        // Flagged ready-to-book by the conversation-analysis sweep. Matches the
        // R5 stage-move criteria exactly ({stages:[id], conversation_intents}).
        base().eq('conversation_intent', 'ready_to_book'),
        // Deliberating deals whose follow-up date has arrived, SMS-reachable.
        // Matches the R0 criteria exactly (closing_temperatures + follow_up_before).
        reachableSms(base())
          .eq('closing_temperature', 'deliberating')
          .not('closing_follow_up_at', 'is', null)
          .lte('closing_follow_up_at', nowIso),
      ])

      return {
        stageId: s.id,
        stageName: s.name,
        slug: s.slug,
        position: s.position,
        kind,
        total: 0, // headers own the true total; the engine doesn't need it
        staleReachableSms: staleRes.count ?? 0,
        hotWarmReachableSms: hotRes.count ?? 0,
        neverContacted: neverRes.count ?? 0,
        readyToBook: readyRes.count ?? 0,
        deliberatingDue: deliberatingDueRes.count ?? 0,
      }
    })
  )

  // ── Dollar layer (Workstream C1) ──────────────────────────────────────────
  // Second pass: expected value per stage/signal via `pipeline_segment_ev`, but
  // ONLY for pairs whose count already clears the rule threshold (so the query
  // count stays bounded — most stage/signal pairs never fire a rule). Skipped
  // entirely when a treatment chip is active: the counts above are then
  // service-filtered while the RPC has no SQL twin of serviceLineOrFilter, and
  // a dollar figure describing a different segment than the count would be
  // worse than none. Every failure degrades to ev=null (counts-only behavior).
  if (!serviceOr) {
    await Promise.all(
      stageSignals.map(async (sig) => {
        const keys = evEligibleSignals(sig)
        if (keys.length === 0) return
        const entries = await Promise.all(
          keys.map(async (key) => [key, await fetchSegmentEv(supabase, orgId, sig, key, nowIso)] as const)
        )
        sig.ev = Object.fromEntries(entries)
      })
    )
  }

  return { stages: stageSignals, staleCutoffIso, nowIso, staleDays: STALE_DAYS }
}
