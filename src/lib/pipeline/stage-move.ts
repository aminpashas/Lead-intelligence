/**
 * Shared stage-move engine.
 *
 * Both stage-change surfaces — the per-lead PATCH (/api/leads/[id]) and the
 * pipeline-recommendation auto-apply (/api/pipeline/recommendations/apply) —
 * route through `applyStageMove` so a stage move always means the same thing:
 * `leads.stage_id` updated, one `stage_changed` activity written per lead, and
 * the stage automations (funnel transition rules + campaign entry/exit) fired.
 * Before this existed the bulk path silently skipped automations, so a lead
 * moved by a recommendation never got the follow-up behavior a hand-dragged
 * lead got.
 *
 * `suppressAutomations` keeps the old bulk behavior available as an explicit,
 * audited choice — every activity row records `automations_fired`, so the
 * suppression decision is never invisible in the timeline.
 *
 * Bulk mechanics: leads are processed in pages of 500 (mirrors the apply
 * route's AUTO_APPLY_PAGE); automations run per lead with bounded concurrency
 * (chunks of 10, sequential chunks) and a per-lead try/catch so one failing
 * automation cannot kill the batch — failures are logged as `automation_error`
 * activities exactly like the per-lead route did.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { executeStageTransition } from '@/lib/funnel/executor'
import { onStageChange } from '@/lib/campaigns/stage-automation'

/** Page size for the bulk `leads.stage_id` update (mirrors AUTO_APPLY_PAGE). */
const MOVE_PAGE = 500

/** How many leads' automations run in parallel within a page. */
export const AUTOMATION_CONCURRENCY = 10

export type StageMoveActor = {
  /** Who initiated the move — a human, the AI (recommendations), or a system job. */
  type: 'user' | 'ai' | 'system'
  /** `user_profiles.id` when a human initiated it. */
  userId?: string
  /** Provenance tag written into activity metadata (e.g. 'pipeline_recommendation'). */
  source: string
}

export type StageMoveParams = {
  organizationId: string
  leadIds: string[]
  toStageId: string
  actor: StageMoveActor
  /** Skip funnel + campaign automations. Default false — automations fire. */
  suppressAutomations?: boolean
  /**
   * The lead's stage BEFORE this move, when the caller already knows it (the
   * per-lead PATCH updates the row before calling in, so re-reading the row
   * would report the NEW stage as "from"). Bulk callers leave this unset and
   * the pre-move stage is read from each row.
   */
  knownFromStageId?: string | null
  /** Activity row title. Default: `Moved to ${stage.name}`. */
  activityTitle?: string
  /** Extra keys merged into each activity row's metadata (e.g. `segment`). */
  activityMetadata?: Record<string, unknown>
}

export type StageMoveResult = {
  /** Leads whose stage_id update was applied. */
  moved: number
  /** Whether automations were (attempted to be) fired — i.e. NOT suppressed. */
  automationsFired: boolean
  /** Per-lead automation failures. Never aborts the batch. */
  automationErrors: Array<{ leadId: string; error: string }>
  /** Set when the move stopped early (unknown stage / update failure). */
  error?: string
}

export function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

export async function applyStageMove(
  supabase: SupabaseClient,
  params: StageMoveParams
): Promise<StageMoveResult> {
  const {
    organizationId,
    leadIds,
    toStageId,
    actor,
    suppressAutomations = false,
    knownFromStageId,
    activityTitle,
    activityMetadata,
  } = params

  const result: StageMoveResult = {
    moved: 0,
    automationsFired: !suppressAutomations,
    automationErrors: [],
  }
  if (leadIds.length === 0) return result

  // Resolve the target stage: name feeds the default activity title, slug is
  // what both automation engines match transition rules on.
  const { data: toStage } = await supabase
    .from('pipeline_stages')
    .select('id, name, slug')
    .eq('id', toStageId)
    .eq('organization_id', organizationId)
    .maybeSingle()
  if (!toStage) {
    return { ...result, automationsFired: false, error: `Unknown stage "${toStageId}"` }
  }

  // id → slug map so each lead's from-stage resolves without a per-lead query.
  const stageSlugById = new Map<string, string>()
  if (!suppressAutomations) {
    const { data: stages } = await supabase
      .from('pipeline_stages')
      .select('id, slug')
      .eq('organization_id', organizationId)
    for (const s of stages || []) stageSlugById.set(s.id as string, s.slug as string)
  }

  /** Best-effort automation-error trail — mirrors the per-lead PATCH route. */
  const recordAutomationError = async (
    leadId: string,
    title: string,
    trigger: string,
    err: unknown
  ) => {
    console.error(`${title} (lead ${leadId}):`, err)
    result.automationErrors.push({
      leadId,
      error: err instanceof Error ? err.message : 'unknown',
    })
    try {
      await supabase.from('lead_activities').insert({
        organization_id: organizationId,
        lead_id: leadId,
        activity_type: 'automation_error',
        title,
        metadata: { error: err instanceof Error ? err.message : 'unknown', trigger },
      })
    } catch {
      /* best effort */
    }
  }

  /** Fire both automation engines for one lead; failures never propagate. */
  const runAutomationsForLead = async (
    lead: Record<string, unknown> & { id: string; stage_id: string | null }
  ) => {
    const fromStageId = knownFromStageId !== undefined ? knownFromStageId : lead.stage_id
    if (fromStageId === toStage.id) return // no transition — nothing to fire
    const fromStageSlug = fromStageId ? stageSlugById.get(fromStageId) ?? null : null

    try {
      await executeStageTransition(supabase, {
        organizationId,
        leadId: lead.id,
        lead: { ...lead, stage_id: toStage.id },
        fromStageSlug,
        toStageSlug: toStage.slug,
      })
    } catch (err) {
      await recordAutomationError(lead.id, 'Funnel automation failed', 'stage_transition', err)
    }

    try {
      await onStageChange(supabase, lead.id, fromStageSlug || 'unknown', toStage.slug, organizationId)
    } catch (err) {
      await recordAutomationError(lead.id, 'Campaign stage automation failed', 'stage_change', err)
    }
  }

  for (const pageIds of chunk(leadIds, MOVE_PAGE)) {
    // Automations need the lead row; the audit trail needs the pre-move stage.
    // When suppressed, only id + prior stage are needed — keep the fetch narrow.
    const { data: rows, error: fetchErr } = await supabase
      .from('leads')
      .select(suppressAutomations ? 'id, stage_id' : '*')
      .in('id', pageIds)
      .eq('organization_id', organizationId)
    if (fetchErr) {
      result.error = fetchErr.message
      return result
    }
    // Cast via unknown: the dynamic select string defeats supabase-js's
    // template-literal result parser.
    const leads = (rows || []) as unknown as Array<
      Record<string, unknown> & { id: string; stage_id: string | null }
    >
    if (leads.length === 0) continue

    const { error: updErr } = await supabase
      .from('leads')
      .update({ stage_id: toStage.id })
      .in('id', pageIds)
      .eq('organization_id', organizationId)
    if (updErr) {
      result.error = updErr.message
      return result
    }

    // One activity-trail row per lead so each move is auditable and visible on
    // the lead timeline — recording whether automations fired for this move.
    await supabase.from('lead_activities').insert(
      leads.map((lead) => ({
        organization_id: organizationId,
        lead_id: lead.id,
        activity_type: 'stage_changed',
        title: activityTitle ?? `Moved to ${toStage.name}`,
        metadata: {
          from_stage: knownFromStageId !== undefined ? knownFromStageId : lead.stage_id ?? null,
          to_stage: toStage.id,
          source: actor.source,
          actor_type: actor.type,
          ...(actor.userId ? { actor_user_id: actor.userId } : {}),
          automations_fired: !suppressAutomations,
          ...activityMetadata,
        },
      }))
    )

    result.moved += leads.length

    // Bounded-concurrency automation fan-out: chunks of AUTOMATION_CONCURRENCY,
    // sequential chunks. Per-lead try/catch lives inside runAutomationsForLead.
    if (!suppressAutomations) {
      for (const group of chunk(leads, AUTOMATION_CONCURRENCY)) {
        await Promise.all(group.map((lead) => runAutomationsForLead(lead)))
      }
    }
  }

  return result
}
