/**
 * Lead hold orchestration: set / clear the hold on a lead and keep its single
 * live 'callback' task in sync. The task IS the "plan" — it carries the callback
 * date (due_at) and surfaces on /tasks. One hold ⇒ one live callback task,
 * enforced by the hold dedupe key + the human_tasks partial unique index.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import {
  createHumanTask,
  resolveAssignee,
  taskDedupeKeyForHold,
  type CreateHumanTaskInput,
} from './tasks'

export type SetHoldParams = {
  organizationId: string
  leadId: string
  leadName: string
  holdUntil: string // ISO
  reason: string | null
  userId: string
}

function holdDateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Pure builder (unit-tested): the callback task for a hold. */
export function buildHoldTaskInput(params: {
  organizationId: string
  leadId: string
  leadName: string
  holdUntil: string
  reason: string | null
  assignedTo: string | null
  assignedRole: string | null
  createdBy: string
}): CreateHumanTaskInput {
  return {
    organization_id: params.organizationId,
    lead_id: params.leadId,
    kind: 'callback',
    // No date baked into the title: refreshExistingTask (tasks.ts) updates due_at
    // on re-hold but not title, so a stale date here would linger through re-holds.
    // The date lives on due_at (shown on /tasks) and in metadata.hold_until.
    title: `Call back ${params.leadName}`,
    detail: params.reason || null,
    due_at: params.holdUntil,
    assigned_to: params.assignedTo,
    assigned_role: params.assignedRole,
    dedupe_key: taskDedupeKeyForHold(params.leadId),
    source: 'lead_hold',
    created_by: params.createdBy,
    metadata: { hold_until: params.holdUntil },
  }
}

/**
 * A follow-up date is a promise to leave the patient alone until then, so when a
 * deal's closing state changes we sync a lead hold to it: a deliberating deal
 * with a future follow-up date is held (pausing all outbound automation via the
 * hold choke point), and a deal that leaves deliberating — or clears its date —
 * releases that hold.
 */
export type FollowUpHoldAction =
  | { action: 'set'; holdUntil: string }
  | { action: 'clear' }
  | { action: 'none' }

/**
 * Pure decision for the follow-up ⇒ do-not-disturb sync. Extracted so its one
 * subtle rule is unit-tested: we only ever release a hold THIS flow placed for a
 * follow-up (`oldHoldUntil === oldFollowUpAt`); an unrelated manual hold a rep
 * set for another reason must be left alone.
 */
export function decideFollowUpHold(params: {
  newTemperature: string | null
  newFollowUpAt: string | null
  oldHoldUntil: string | null
  oldFollowUpAt: string | null
  now?: Date
}): FollowUpHoldAction {
  const now = params.now ?? new Date()

  const wantHold =
    params.newTemperature === 'deliberating' &&
    !!params.newFollowUpAt &&
    new Date(params.newFollowUpAt).getTime() > now.getTime()
  if (wantHold) return { action: 'set', holdUntil: params.newFollowUpAt! }

  const holdWasTrackingFollowUp =
    !!params.oldHoldUntil &&
    !!params.oldFollowUpAt &&
    params.oldHoldUntil === params.oldFollowUpAt
  if (holdWasTrackingFollowUp) return { action: 'clear' }

  return { action: 'none' }
}

/** Set (or update) a hold on a lead, minting/refreshing its callback task. */
export async function setLeadHold(
  supabase: SupabaseClient,
  params: SetHoldParams,
): Promise<{ ok: boolean; taskId: string | null }> {
  const nowIso = new Date().toISOString()
  const { error: updErr } = await supabase
    .from('leads')
    .update({
      hold_until: params.holdUntil,
      hold_reason: params.reason,
      hold_set_by: params.userId,
      hold_set_at: nowIso,
    })
    .eq('id', params.leadId)
    .eq('organization_id', params.organizationId)

  if (updErr) {
    logger.warn('LeadHold: failed to set hold', { leadId: params.leadId, error: updErr.message })
    return { ok: false, taskId: null }
  }

  const assignee = await resolveAssignee(supabase, params.organizationId, params.leadId)
  const { taskId } = await createHumanTask(
    supabase,
    buildHoldTaskInput({
      organizationId: params.organizationId,
      leadId: params.leadId,
      leadName: params.leadName,
      holdUntil: params.holdUntil,
      reason: params.reason,
      assignedTo: assignee.userId,
      assignedRole: assignee.role,
      createdBy: params.userId,
    }),
  )

  await supabase.from('lead_activities').insert({
    organization_id: params.organizationId,
    lead_id: params.leadId,
    activity_type: 'hold_set',
    title: `On hold until ${holdDateLabel(params.holdUntil)}`,
    metadata: { hold_until: params.holdUntil, reason: params.reason, actor_user_id: params.userId },
  })

  return { ok: true, taskId }
}

/**
 * Clear a hold (manual clear or expiry). Nulls the columns and completes the
 * live callback task. `via` distinguishes a manual clear from expiry for the log.
 */
export async function clearLeadHold(
  supabase: SupabaseClient,
  params: { organizationId: string; leadId: string; via: 'manual' | 'expiry'; userId?: string },
): Promise<{ ok: boolean }> {
  const { error } = await supabase
    .from('leads')
    .update({ hold_until: null, hold_reason: null, hold_set_by: null, hold_set_at: null })
    .eq('id', params.leadId)
    .eq('organization_id', params.organizationId)

  if (error) {
    logger.warn('LeadHold: failed to clear hold', { leadId: params.leadId, error: error.message })
    return { ok: false }
  }

  await supabase
    .from('human_tasks')
    .update({ status: 'done', completed_at: new Date().toISOString() })
    .eq('organization_id', params.organizationId)
    .eq('dedupe_key', taskDedupeKeyForHold(params.leadId))
    .in('status', ['open', 'claimed'])

  await supabase.from('lead_activities').insert({
    organization_id: params.organizationId,
    lead_id: params.leadId,
    activity_type: 'hold_cleared',
    title: params.via === 'expiry' ? 'Hold expired' : 'Hold cleared',
    metadata: { via: params.via, ...(params.userId ? { actor_user_id: params.userId } : {}) },
  })

  return { ok: true }
}
