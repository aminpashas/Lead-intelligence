/**
 * Human Task Lane (Workstream D2)
 *
 * When the D1 allocation resolver (`resolveAutomationOwner`) says a HUMAN owns
 * an automation touch, the automation stands down and a `human_tasks` row is
 * created here instead — carrying the AI's context (draft, detail, SLA) so the
 * human starts warm.
 *
 * Dedupe: repeated triggers for the same unit of work (a lead texting twice
 * before staff reply) collapse into ONE live task via `dedupe_key`; the second
 * trigger refreshes the existing open/claimed row (detail/ai_draft/due_at)
 * rather than inserting a duplicate. Enforced by a partial unique index over
 * open/claimed rows, with a select-then-insert + retry-on-conflict here since
 * PostgREST upsert can't target a partial unique index.
 *
 * Task creation must NEVER take the automation spine down: every entry point
 * fails soft (returns null / logs) on database errors.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

export type HumanTaskKind =
  | 'inbound_reply'
  | 'first_touch'
  | 'nurture_step'
  | 'stage_automation'
  | 'recommendation'
  | 'sla_breach_review'
  | 'call_review'
  // On-demand call task generated from a Smart List (the call-queue action),
  // as opposed to the automatic allocation-engine kinds above.
  | 'list_call'
  // Plain to-do hand-created by staff from the /tasks page.
  | 'manual'
  // State-shaped work materialized by the task sweep (a follow-up that is due, a
  // patient awaiting a reply). Distinct from the event-driven kinds above so the
  // sweep and the allocation engine can never dedupe onto each other's rows.
  | 'follow_up'
  // A dated callback the rep committed to; minted when a lead is put on hold.
  // due_at is the hold date. See src/lib/automation/hold-tasks.ts.
  | 'callback'
  // A cluster of likely-duplicate leads the sweep found, for an admin to review
  // and merge. One live task per cluster. See src/lib/leads/duplicate-review-sweep.ts.
  | 'duplicate_review'

/** Manual-task urgency. Allocation-created tasks keep the 'normal' default. */
export type HumanTaskPriority = 'low' | 'normal' | 'high' | 'urgent'

export type HumanTaskStatus =
  | 'open'
  | 'claimed'
  | 'done'
  | 'expired'
  | 'taken_by_ai'
  | 'dismissed'

/** Row of human_tasks. */
export type HumanTask = {
  id: string
  organization_id: string
  lead_id: string | null
  conversation_id: string | null
  campaign_id: string | null
  policy_id: string | null
  recommendation_id: string | null
  kind: HumanTaskKind
  title: string
  detail: string | null
  ai_draft: string | null
  assigned_to: string | null
  assigned_role: string | null
  status: HumanTaskStatus
  priority: HumanTaskPriority
  due_at: string | null
  claimed_by: string | null
  claimed_at: string | null
  completed_at: string | null
  reviewed_at: string | null
  reviewed_by: string | null
  source: string
  dedupe_key: string | null
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type CreateHumanTaskInput = {
  organization_id: string
  kind: HumanTaskKind
  title: string
  /** Which system created the task ('allocation', 'recommendation_apply', ...). */
  source: string
  lead_id?: string | null
  conversation_id?: string | null
  campaign_id?: string | null
  policy_id?: string | null
  recommendation_id?: string | null
  detail?: string | null
  ai_draft?: string | null
  assigned_to?: string | null
  assigned_role?: string | null
  /** Urgency (defaults to 'normal' at the DB level when omitted). */
  priority?: HumanTaskPriority
  /** ISO timestamp; the SLA deadline for 'hold' allocations (D3 enforces). */
  due_at?: string | null
  dedupe_key?: string | null
  metadata?: Record<string, unknown>
  /** The Smart List a 'list_call' task was generated from (traceability). */
  source_smart_list_id?: string | null
  /** The staff user who created the task (null for allocation-created tasks). */
  created_by?: string | null
}

export type CreateHumanTaskResult = {
  taskId: string | null
  /** True when an existing open/claimed task was refreshed instead of inserted. */
  deduped: boolean
}

export type ResolvedAssignee = {
  /** Best single assignee, or null when only a role-level pool exists. */
  userId: string | null
  /** Role the task routes to when no specific user matched. */
  role: string | null
  /** Every active user considered eligible (for future round-robin / notify). */
  pool: string[]
}

/** Postgres unique-violation SQLSTATE (the dedupe-race signal). */
const UNIQUE_VIOLATION = '23505'

/**
 * Roles that inherit a task nobody else owns (resolveAssignee tier 3).
 *
 * The old fallback was a bare role='admin'. Most practices don't have an
 * 'admin' — SF Dentistry runs on office_manager + nurse — so every tier missed
 * and tasks landed with assigned_to AND assigned_role null: claimable from
 * "All open", but invisible in "Mine" forever.
 *
 * TODO(amin): define the fallback. Constraints worth weighing:
 *   - `nurse` / `doctor` / `assistant` hold CLINICAL_PERMISSIONS only — they
 *     deliberately can't work the book at scale (see isFocusedStaff), so
 *     routing patient follow-ups to them contradicts the permission model.
 *   - `office_manager` / `owner` / `admin` / `doctor_admin` hold
 *     FULL_PERMISSIONS; `isAdminRole()` in lib/auth/permissions.ts already
 *     groups exactly those (plus agency_admin).
 *   - Order matters: this is a priority list, first role with an active user
 *     wins the queue. Putting `owner` first would page the dentist about a
 *     re-engagement text; putting `office_manager` first routes it to the desk.
 *   - agency_admin is intentionally excluded below — an agency contractor
 *     shouldn't silently inherit a practice's patient follow-ups.
 */
const TASK_FALLBACK_ROLES: string[] = ['admin']

const LIVE_STATUSES: HumanTaskStatus[] = ['open', 'claimed']

// ── Dedupe keys ──────────────────────────────────────────────────────

/** All inbound replies on one conversation collapse into one live task. */
export function taskDedupeKeyForInbound(conversationId: string): string {
  return `inbound:${conversationId}`
}

/** A lead only ever needs one live first-touch task. */
export function taskDedupeKeyForFirstTouch(leadId: string): string {
  return `first_touch:${leadId}`
}

/**
 * One live call task per (Smart List, lead): re-running the call-queue action
 * on the same list collapses onto the existing open/claimed task rather than
 * piling up duplicates. Scoped to the list — the same lead can still hold a
 * live call task from a different list. Once the task is completed/dismissed it
 * leaves the partial index, so a later run can re-queue that lead.
 */
export function taskDedupeKeyForListCall(smartListId: string, leadId: string): string {
  return `list_call:${smartListId}:${leadId}`
}

/** One live callback task per held lead. Cleared when the hold is cleared/expires. */
export function taskDedupeKeyForHold(leadId: string): string {
  return `hold:${leadId}`
}

// ── Priority ─────────────────────────────────────────────────────────

/**
 * Priority for an allocation-created task.
 *
 * Routine human-owned work ('human') stays 'normal'. A human-first HOLD carries
 * a ticking SLA before the AI takes over, so it must outrank routine tasks on
 * the /tasks board (which re-sorts by priority): 'urgent' when the window is
 * tight (<= 5 min), 'high' otherwise. Without this every allocation task landed
 * at 'normal', so priority never differentiated the queue.
 */
export function allocationTaskPriority(
  owner: 'ai' | 'human' | 'hold',
  slaSeconds: number | null | undefined
): HumanTaskPriority {
  if (owner === 'hold' && slaSeconds && slaSeconds > 0) {
    return slaSeconds <= 300 ? 'urgent' : 'high'
  }
  return 'normal'
}

// ── Create (upsert-on-dedupe) ────────────────────────────────────────

/**
 * Create a human task, collapsing onto an existing live task with the same
 * dedupe_key. On dedupe the row's detail / ai_draft / due_at / metadata are
 * refreshed (freshest AI context wins) while created_at and the current
 * assignee/claim are kept — the human keeps ownership, the context updates.
 *
 * Race between two concurrent triggers: the loser's insert hits the partial
 * unique index (23505) and retries as an update against the winner's row.
 */
export async function createHumanTask(
  supabase: SupabaseClient,
  input: CreateHumanTaskInput
): Promise<CreateHumanTaskResult> {
  try {
    if (input.dedupe_key) {
      const existingId = await findLiveTaskByDedupeKey(supabase, input)
      if (existingId) {
        await refreshExistingTask(supabase, existingId, input)
        return { taskId: existingId, deduped: true }
      }
    }

    const { data, error } = await insertTask(supabase, input)
    if (!error && data) return { taskId: data.id, deduped: false }

    // Dedupe race: someone inserted the same live dedupe_key between our
    // select and insert. Re-select and refresh their row instead.
    if (error?.code === UNIQUE_VIOLATION && input.dedupe_key) {
      const existingId = await findLiveTaskByDedupeKey(supabase, input)
      if (existingId) {
        await refreshExistingTask(supabase, existingId, input)
        return { taskId: existingId, deduped: true }
      }
    }

    logger.warn('HumanTasks: failed to create task', {
      organization_id: input.organization_id,
      kind: input.kind,
      dedupe_key: input.dedupe_key ?? null,
      error: error?.message,
    })
    return { taskId: null, deduped: false }
  } catch (err) {
    logger.warn('HumanTasks: createHumanTask threw', {
      organization_id: input.organization_id,
      kind: input.kind,
      error: err instanceof Error ? err.message : String(err),
    })
    return { taskId: null, deduped: false }
  }
}

async function findLiveTaskByDedupeKey(
  supabase: SupabaseClient,
  input: CreateHumanTaskInput
): Promise<string | null> {
  const { data } = await supabase
    .from('human_tasks')
    .select('id')
    .eq('organization_id', input.organization_id)
    .eq('dedupe_key', input.dedupe_key!)
    .in('status', LIVE_STATUSES)
    .limit(1)
    .maybeSingle()
  return data?.id ?? null
}

async function insertTask(supabase: SupabaseClient, input: CreateHumanTaskInput) {
  return supabase
    .from('human_tasks')
    .insert({
      organization_id: input.organization_id,
      lead_id: input.lead_id ?? null,
      conversation_id: input.conversation_id ?? null,
      campaign_id: input.campaign_id ?? null,
      policy_id: input.policy_id ?? null,
      recommendation_id: input.recommendation_id ?? null,
      kind: input.kind,
      title: input.title,
      detail: input.detail ?? null,
      ai_draft: input.ai_draft ?? null,
      assigned_to: input.assigned_to ?? null,
      assigned_role: input.assigned_role ?? null,
      status: 'open',
      priority: input.priority ?? 'normal',
      due_at: input.due_at ?? null,
      source: input.source,
      dedupe_key: input.dedupe_key ?? null,
      metadata: input.metadata ?? {},
      source_smart_list_id: input.source_smart_list_id ?? null,
      created_by: input.created_by ?? null,
    })
    .select('id')
    .single()
}

/** Refresh the AI context on a live task; keep created_at + assignee/claim. */
async function refreshExistingTask(
  supabase: SupabaseClient,
  taskId: string,
  input: CreateHumanTaskInput
): Promise<void> {
  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  }
  if (input.detail !== undefined) updates.detail = input.detail
  if (input.ai_draft !== undefined) updates.ai_draft = input.ai_draft
  if (input.due_at !== undefined) updates.due_at = input.due_at
  if (input.metadata !== undefined) updates.metadata = input.metadata

  await supabase.from('human_tasks').update(updates).eq('id', taskId)
}

// ── Assignee resolution ──────────────────────────────────────────────

/**
 * Resolve who a task should be routed to, most specific first:
 *   1. The lead's owner (leads.assigned_to) if that user is still active.
 *   2. Active users with the policy's assigned role (assignedRole param).
 *   3. Org admins (same recipient query + cap as escalation.notifyStaff).
 *
 * Returns { userId, role, pool }: userId is the single best assignee (or null
 * when work should sit in a role queue), pool is every eligible user (for
 * D5 notifications / future round-robin).
 */
export async function resolveAssignee(
  supabase: SupabaseClient,
  orgId: string,
  leadId?: string | null,
  assignedRole?: string | null
): Promise<ResolvedAssignee> {
  try {
    // 1. Lead owner, if still an active user in this org.
    if (leadId) {
      const { data: lead } = await supabase
        .from('leads')
        .select('assigned_to')
        .eq('id', leadId)
        .maybeSingle()
      if (lead?.assigned_to) {
        const { data: owner } = await supabase
          .from('user_profiles')
          .select('id, role')
          .eq('id', lead.assigned_to)
          .eq('organization_id', orgId)
          .eq('is_active', true)
          .maybeSingle()
        if (owner) {
          return { userId: owner.id, role: (owner.role as string) ?? null, pool: [owner.id] }
        }
      }
    }

    // 2. Active users holding the requested role.
    if (assignedRole) {
      const { data: roleUsers } = await supabase
        .from('user_profiles')
        .select('id')
        .eq('organization_id', orgId)
        .eq('role', assignedRole)
        .eq('is_active', true)
        .limit(5)
      if (roleUsers && roleUsers.length > 0) {
        return {
          userId: null, // role queue — anyone with the role can claim it
          role: assignedRole,
          pool: roleUsers.map((u: { id: string }) => u.id),
        }
      }
    }

    // 3. Fallback roles, most-appropriate first: the first role that has active
    //    users takes the task as a role queue (anyone holding it can claim).
    for (const role of TASK_FALLBACK_ROLES) {
      const { data: users } = await supabase
        .from('user_profiles')
        .select('id')
        .eq('organization_id', orgId)
        .eq('role', role)
        .eq('is_active', true)
        .limit(5)
      if (users && users.length > 0) {
        return { userId: null, role, pool: users.map((u: { id: string }) => u.id) }
      }
    }

    // Nobody eligible: the task still exists and is claimable from "All open",
    // it just isn't routed. Logged because a permanently unrouted queue is a
    // configuration problem, not a normal state.
    logger.warn('HumanTasks: no assignee found — task will be unrouted', {
      orgId,
      leadId: leadId ?? null,
      fallbackRoles: TASK_FALLBACK_ROLES,
    })
    return { userId: null, role: null, pool: [] }
  } catch (err) {
    logger.warn('HumanTasks: resolveAssignee failed', {
      orgId,
      leadId: leadId ?? null,
      error: err instanceof Error ? err.message : String(err),
    })
    return { userId: null, role: null, pool: [] }
  }
}

// ── Completion ───────────────────────────────────────────────────────

/**
 * Close the live inbound-reply task(s) for a conversation — called when a
 * human actually replies on the thread (and by D3's SLA sweep with
 * terminalStatus 'taken_by_ai' when the AI takes over after the hold expires).
 *
 * Returns the number of tasks closed.
 */
export async function completeTasksForConversation(
  supabase: SupabaseClient,
  conversationId: string,
  completedBy?: string | null,
  terminalStatus: 'done' | 'expired' | 'taken_by_ai' | 'dismissed' = 'done'
): Promise<number> {
  try {
    const dedupeKey = taskDedupeKeyForInbound(conversationId)
    const now = new Date().toISOString()

    // Credit the completing human as the claimer when nobody had claimed the
    // task — without stealing credit from an existing claimer.
    if (completedBy) {
      await supabase
        .from('human_tasks')
        .update({ claimed_by: completedBy, claimed_at: now })
        .eq('dedupe_key', dedupeKey)
        .in('status', LIVE_STATUSES)
        .is('claimed_by', null)
    }

    const { data, error } = await supabase
      .from('human_tasks')
      .update({ status: terminalStatus, completed_at: now, updated_at: now })
      .eq('dedupe_key', dedupeKey)
      .in('status', LIVE_STATUSES)
      .select('id')

    if (error) {
      logger.warn('HumanTasks: completeTasksForConversation failed', {
        conversationId,
        error: error.message,
      })
      return 0
    }
    return data?.length ?? 0
  } catch (err) {
    logger.warn('HumanTasks: completeTasksForConversation threw', {
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    })
    return 0
  }
}
