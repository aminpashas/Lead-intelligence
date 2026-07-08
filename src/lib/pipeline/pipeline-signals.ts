import type { SupabaseClient } from '@supabase/supabase-js'
import type { PipelineStage } from '@/types/database'
import { isOperationalStage } from './stage-groups'
import type { PipelineSignals, StageSignal } from './recommendations'

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

  return { stages: stageSignals, staleCutoffIso, nowIso, staleDays: STALE_DAYS }
}
