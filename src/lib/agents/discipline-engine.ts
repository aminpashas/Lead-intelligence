/**
 * Discipline / reward engine.
 *
 * Runs after the weekly review cron writes agent_performance_reviews
 * and updates agent_status_current. For each agent:
 *
 *   green streak ≥2 weeks → reward: multiplier += 0.25 (cap 2.0)
 *   yellow                → no change
 *   red                   → multiplier = max(0.50, current - 0.25)
 *   probation             → multiplier = 0.50 AND autopilot 'review_first'
 *                           AND attempt protocol swap (live if
 *                           organizations.auto_tune_enabled=true,
 *                           otherwise log 'protocol_proposed')
 *   green again after red → restore multiplier toward 1.0,
 *                           clear autopilot_mode_override
 *
 * Every change writes an agent_protocol_changes audit row.
 *
 * Phase C of the AI Agent KPI Dashboard system.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import type { AgentGrade } from './grading'

const REWARD_STEP = 0.25
const DISCIPLINE_STEP = 0.25
const PROBATION_MULTIPLIER = 0.5
const MAX_MULTIPLIER = 2.0
const MIN_MULTIPLIER = 0.5
const RESTORE_TARGET = 1.0

type StatusRow = {
  agent_id: string
  organization_id: string
  status: AgentGrade
  consecutive_red_periods: number
  consecutive_green_periods: number
  last_review_id: string | null
}

type CapRow = {
  agent_id: string
  organization_id: string
  base_daily_cap: number
  multiplier: number
  autopilot_mode_override: 'auto' | 'review_first' | 'off' | null
}

export type DisciplineAction = {
  agent_id: string
  agent_name?: string
  status: AgentGrade
  change_type:
    | 'protocol_swap'
    | 'cap_increase'
    | 'cap_decrease'
    | 'autopilot_throttle'
    | 'protocol_proposed'
    | 'restore'
  from_multiplier: number
  to_multiplier: number
  triggered_by: 'auto_discipline' | 'auto_reward'
  reason: string
}

/**
 * Apply reward/discipline to one agent's cap row. Returns the new
 * cap state plus a list of audit entries to write. Pure-ish — no DB
 * writes; the orchestrator commits.
 */
function decideAction(
  status: StatusRow,
  cap: CapRow
): { newMultiplier: number; newAutopilot: CapRow['autopilot_mode_override']; actions: DisciplineAction[] } {
  const actions: DisciplineAction[] = []
  let mult = Number(cap.multiplier)
  let autopilot: CapRow['autopilot_mode_override'] = cap.autopilot_mode_override

  switch (status.status) {
    case 'green': {
      // Reward only if streak ≥ 2 (one good week could be noise)
      if (status.consecutive_green_periods >= 2 && mult < MAX_MULTIPLIER) {
        const next = Math.min(MAX_MULTIPLIER, mult + REWARD_STEP)
        if (next !== mult) {
          actions.push({
            agent_id: status.agent_id,
            status: status.status,
            change_type: 'cap_increase',
            from_multiplier: mult,
            to_multiplier: next,
            triggered_by: 'auto_reward',
            reason: `Green streak ${status.consecutive_green_periods} weeks → cap reward.`,
          })
          mult = next
        }
      }
      // Restore autopilot if previously throttled
      if (autopilot && autopilot !== 'auto') {
        actions.push({
          agent_id: status.agent_id,
          status: status.status,
          change_type: 'autopilot_throttle',
          from_multiplier: mult,
          to_multiplier: mult,
          triggered_by: 'auto_reward',
          reason: 'Recovered to green — restoring full autopilot.',
        })
        autopilot = 'auto'
      }
      // Restore multiplier toward 1.0 if it was previously docked
      if (mult < RESTORE_TARGET) {
        const next = Math.min(RESTORE_TARGET, mult + REWARD_STEP)
        if (next !== mult) {
          actions.push({
            agent_id: status.agent_id,
            status: status.status,
            change_type: 'cap_increase',
            from_multiplier: mult,
            to_multiplier: next,
            triggered_by: 'auto_reward',
            reason: 'Recovering from prior discipline — cap step toward 1.0.',
          })
          mult = next
        }
      }
      break
    }
    case 'yellow':
      // No automatic action. Yellow is the warning zone — let the
      // human decide whether to intervene.
      break
    case 'red': {
      const next = Math.max(MIN_MULTIPLIER, mult - DISCIPLINE_STEP)
      if (next !== mult) {
        actions.push({
          agent_id: status.agent_id,
          status: status.status,
          change_type: 'cap_decrease',
          from_multiplier: mult,
          to_multiplier: next,
          triggered_by: 'auto_discipline',
          reason: `Red review → cap discipline (-${DISCIPLINE_STEP}).`,
        })
        mult = next
      }
      break
    }
    case 'probation': {
      if (mult > PROBATION_MULTIPLIER) {
        actions.push({
          agent_id: status.agent_id,
          status: status.status,
          change_type: 'cap_decrease',
          from_multiplier: mult,
          to_multiplier: PROBATION_MULTIPLIER,
          triggered_by: 'auto_discipline',
          reason: `Probation (${status.consecutive_red_periods} consecutive red weeks) → cap to ${PROBATION_MULTIPLIER}.`,
        })
        mult = PROBATION_MULTIPLIER
      }
      if (autopilot !== 'review_first') {
        actions.push({
          agent_id: status.agent_id,
          status: status.status,
          change_type: 'autopilot_throttle',
          from_multiplier: mult,
          to_multiplier: mult,
          triggered_by: 'auto_discipline',
          reason: 'Probation → autopilot to review_first (human approves AI sends).',
        })
        autopilot = 'review_first'
      }
      break
    }
    case 'unrated':
      // No action — agent is brand new or had no traffic.
      break
  }

  return { newMultiplier: mult, newAutopilot: autopilot, actions }
}

/**
 * Look for an alternate inactive protocol to swap to. Returns null
 * if no candidate exists. Picks the most recently created inactive
 * version that isn't the current active one.
 */
async function findSwapCandidate(
  supabase: SupabaseClient,
  agentId: string
): Promise<{ activeId: string | null; candidateId: string | null }> {
  const { data } = await supabase
    .from('agent_protocols')
    .select('id, is_active, created_at')
    .eq('agent_id', agentId)
    .order('created_at', { ascending: false })

  const protocols = (data ?? []) as Array<{ id: string; is_active: boolean; created_at: string }>
  const active = protocols.find((p) => p.is_active) ?? null
  const candidate = protocols.find((p) => !p.is_active) ?? null
  return { activeId: active?.id ?? null, candidateId: candidate?.id ?? null }
}

/**
 * Run discipline / reward across every agent in an org. Idempotent
 * per period — if you call it twice on the same status row the
 * second call generates no actions (multiplier already at target).
 */
export async function runDisciplineEngine(
  supabase: SupabaseClient,
  orgId: string
): Promise<{
  actions: DisciplineAction[]
  protocolSwapsLive: number
  protocolSwapsProposed: number
}> {
  // Master safety rail
  const { data: orgRow } = await supabase
    .from('organizations')
    .select('auto_tune_enabled')
    .eq('id', orgId)
    .single()
  const autoTuneLive = Boolean(orgRow?.auto_tune_enabled)

  const { data: statusRows } = await supabase
    .from('agent_status_current')
    .select('agent_id, organization_id, status, consecutive_red_periods, consecutive_green_periods, last_review_id')
    .eq('organization_id', orgId)

  const statuses = (statusRows ?? []) as StatusRow[]
  if (statuses.length === 0) {
    return { actions: [], protocolSwapsLive: 0, protocolSwapsProposed: 0 }
  }

  const agentIds = statuses.map((s) => s.agent_id)

  const { data: capRows } = await supabase
    .from('agent_lead_caps')
    .select('agent_id, organization_id, base_daily_cap, multiplier, autopilot_mode_override')
    .in('agent_id', agentIds)

  const capByAgent = new Map<string, CapRow>(
    ((capRows ?? []) as CapRow[]).map((r) => [r.agent_id, r])
  )

  const allActions: DisciplineAction[] = []
  let protocolSwapsLive = 0
  let protocolSwapsProposed = 0

  for (const status of statuses) {
    const cap = capByAgent.get(status.agent_id)
    if (!cap) continue

    const { newMultiplier, newAutopilot, actions } = decideAction(status, cap)

    // Persist cap changes if anything moved
    if (newMultiplier !== Number(cap.multiplier) || newAutopilot !== cap.autopilot_mode_override) {
      const { error: capErr } = await supabase
        .from('agent_lead_caps')
        .update({
          multiplier: newMultiplier,
          autopilot_mode_override: newAutopilot,
          updated_at: new Date().toISOString(),
        })
        .eq('agent_id', status.agent_id)

      if (capErr) {
        logger.error('Discipline engine: failed to update cap', {
          agent_id: status.agent_id,
          error: capErr.message,
        })
        continue
      }
    }

    // Audit-log every action
    for (const action of actions) {
      await supabase.from('agent_protocol_changes').insert({
        agent_id: status.agent_id,
        organization_id: orgId,
        change_type: action.change_type,
        triggered_by: action.triggered_by,
        from_multiplier: action.from_multiplier,
        to_multiplier: action.to_multiplier,
        reason: action.reason,
        reference_review_id: status.last_review_id,
      })
    }

    allActions.push(...actions)

    // Probation → attempt protocol swap
    if (status.status === 'probation') {
      const { activeId, candidateId } = await findSwapCandidate(supabase, status.agent_id)
      if (candidateId) {
        if (autoTuneLive) {
          // Live swap
          if (activeId) {
            await supabase
              .from('agent_protocols')
              .update({ is_active: false })
              .eq('id', activeId)
          }
          await supabase
            .from('agent_protocols')
            .update({ is_active: true })
            .eq('id', candidateId)

          await supabase.from('agent_protocol_changes').insert({
            agent_id: status.agent_id,
            organization_id: orgId,
            change_type: 'protocol_swap',
            triggered_by: 'auto_discipline',
            from_protocol_id: activeId,
            to_protocol_id: candidateId,
            reason: 'Probation auto-swap: switched to alternate protocol.',
            reference_review_id: status.last_review_id,
          })
          protocolSwapsLive++
        } else {
          // Propose only — admin must enable auto_tune to act
          await supabase.from('agent_protocol_changes').insert({
            agent_id: status.agent_id,
            organization_id: orgId,
            change_type: 'protocol_proposed',
            triggered_by: 'auto_discipline',
            from_protocol_id: activeId,
            to_protocol_id: candidateId,
            reason:
              'Probation: engine proposed protocol swap. Set organizations.auto_tune_enabled=true to apply automatically.',
            reference_review_id: status.last_review_id,
          })
          protocolSwapsProposed++
        }
      }
    }
  }

  return { actions: allActions, protocolSwapsLive, protocolSwapsProposed }
}

/**
 * Get the effective daily cap for an agent (base × multiplier),
 * with optional autopilot override. Speed-to-lead and campaign
 * executor consult this before allocating new sends.
 */
export async function getEffectiveAgentCap(
  supabase: SupabaseClient,
  agentId: string
): Promise<{ effectiveCap: number; autopilotMode: 'auto' | 'review_first' | 'off' } | null> {
  const { data } = await supabase
    .from('agent_lead_caps')
    .select('base_daily_cap, multiplier, autopilot_mode_override')
    .eq('agent_id', agentId)
    .maybeSingle()
  if (!data) return null
  return {
    effectiveCap: Math.floor(Number(data.base_daily_cap) * Number(data.multiplier)),
    autopilotMode: (data.autopilot_mode_override as 'auto' | 'review_first' | 'off' | null) ?? 'auto',
  }
}

export type CapacityCheckResult =
  | { allowed: true; remaining: number; effectiveCap: number; autopilotMode: 'auto' }
  | { allowed: false; reason: 'cap_reached' | 'autopilot_review_first' | 'autopilot_off' | 'no_cap_row'; remaining?: number; effectiveCap?: number; autopilotMode?: 'auto' | 'review_first' | 'off' }

/**
 * Decide whether an agent can take on another lead-message right now.
 * Counts that agent's AI-authored outbound messages sent today and
 * compares to base × multiplier. Also honors the autopilot override
 * (probation forces 'review_first' which means no auto-sends).
 *
 * If the agent has no cap row (shouldn't happen post-migration 034
 * but be defensive), allow the send — fail-open is safer than
 * locking out an org because of a missing row.
 */
export async function checkAgentCapacity(
  supabase: SupabaseClient,
  agentId: string
): Promise<CapacityCheckResult> {
  const cap = await getEffectiveAgentCap(supabase, agentId)
  if (!cap) {
    return { allowed: false, reason: 'no_cap_row' }
  }

  if (cap.autopilotMode === 'off') {
    return { allowed: false, reason: 'autopilot_off', autopilotMode: 'off', effectiveCap: cap.effectiveCap }
  }

  if (cap.autopilotMode === 'review_first') {
    return { allowed: false, reason: 'autopilot_review_first', autopilotMode: 'review_first', effectiveCap: cap.effectiveCap }
  }

  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)

  const { count } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('agent_id', agentId)
    .eq('direction', 'outbound')
    .eq('sender_type', 'ai')
    .gte('created_at', todayStart.toISOString())

  const sentToday = count ?? 0
  const remaining = Math.max(0, cap.effectiveCap - sentToday)

  if (sentToday >= cap.effectiveCap) {
    return {
      allowed: false,
      reason: 'cap_reached',
      remaining: 0,
      effectiveCap: cap.effectiveCap,
      autopilotMode: 'auto',
    }
  }

  return {
    allowed: true,
    remaining,
    effectiveCap: cap.effectiveCap,
    autopilotMode: 'auto',
  }
}
