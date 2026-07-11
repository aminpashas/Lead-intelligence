/**
 * Automation Allocation Resolver (Workstream D1)
 *
 * Decides WHO owns a given automation touch — the AI, a human, or "hold"
 * (human-first with an SLA before the AI may take over) — based on
 * `automation_policies` rows plus the org-level human-first fallback.
 *
 * DORMANT BY DEFAULT: with zero policy rows and
 * organizations.human_first_sla_enabled = false, `resolveAllocation` returns
 * `{ owner: 'ai', reason: 'legacy_default' }` — exactly today's behavior.
 * Callers only diverge from the legacy path once someone creates policy rows
 * or flips the org toggle.
 *
 * Precedence (most specific target wins): campaign > stage > segment > org_default.
 * Within a matching policy:
 *   - human_first          → owner 'hold' + the policy's SLA (D2/D3 enforce it)
 *   - owner 'ai' / 'human' → as configured
 *   - owner 'hybrid'       → human_schedule evaluated in the org's timezone;
 *                            enabled day + hour in [start, end) = HUMAN hours,
 *                            everything else belongs to the AI.
 *
 * NOTE on 'hold': this phase only RETURNS the decision. Task creation and SLA
 * timers are D2/D3 — see the "D2/D3 wiring point" TODOs at the call sites.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  getLocalHourAndDay,
  type WeekSchedule,
  type DaySchedule,
} from '@/lib/autopilot/config'
import type { AutomationPolicy } from '@/types/database'
import { logger } from '@/lib/logger'

export type AllocationKind =
  | 'inbound_reply'
  | 'speed_to_lead'
  | 'nurture_step'
  | 'stage_automation'
  | 'recommendation'

export type AllocationContext = {
  organizationId: string
  kind: AllocationKind
  campaignId?: string
  voiceCampaignId?: string
  stageId?: string
  smartListId?: string
  agentType?: 'setter' | 'closer'
  now?: Date
}

export type AllocationDecision = {
  owner: 'ai' | 'human' | 'hold'
  reason: string
  policyId: string | null
  slaSeconds: number | null
  aiRole: 'setter' | 'closer' | null
}

/** Org-level inputs the pure resolver needs (subset of organizations columns). */
export type AllocationOrgConfig = {
  /** IANA timezone used to evaluate hybrid human_schedule (same source as autopilot). */
  timezone: string
  human_first_sla_enabled: boolean
  human_first_sla_seconds: number
}

const LEGACY_DEFAULT: AllocationDecision = {
  owner: 'ai',
  reason: 'legacy_default',
  policyId: null,
  slaSeconds: null,
  aiRole: null,
}

/**
 * Load all ENABLED allocation policies for an org in a single query.
 */
export async function loadPoliciesForOrg(
  supabase: SupabaseClient,
  organizationId: string
): Promise<AutomationPolicy[]> {
  const { data, error } = await supabase
    .from('automation_policies')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('enabled', true)

  if (error) {
    // Fail open to the legacy path — a broken policy read must never take the
    // automation spine down with it.
    logger.warn('Allocation: failed to load automation_policies', {
      organizationId,
      error: error.message,
    })
    return []
  }
  return (data ?? []) as AutomationPolicy[]
}

/** Precedence order for scope matching (most specific first). */
const SCOPE_PRECEDENCE: Array<AutomationPolicy['scope']> = [
  'campaign',
  'stage',
  'segment',
  'org_default',
]

/**
 * PURE resolver — no I/O, fully unit-testable.
 *
 * Zero matching policies + org toggle off → legacy default (owner 'ai').
 */
export function resolveAllocation(
  policies: AutomationPolicy[],
  orgConfig: AllocationOrgConfig,
  ctx: AllocationContext
): AllocationDecision {
  const candidates = policies.filter(
    (p) => p.enabled && kindMatches(p, ctx.kind) && scopeTargetMatches(p, ctx)
  )

  let policy: AutomationPolicy | undefined
  for (const scope of SCOPE_PRECEDENCE) {
    policy = candidates.find((p) => p.scope === scope)
    if (policy) break
  }

  if (!policy) {
    // Org-level human-first fallback applies only to inbound replies, and only
    // when no policy row said otherwise.
    if (orgConfig.human_first_sla_enabled && ctx.kind === 'inbound_reply') {
      return {
        owner: 'hold',
        reason: 'org_human_first_sla',
        policyId: null,
        slaSeconds: orgConfig.human_first_sla_seconds,
        aiRole: null,
      }
    }
    return LEGACY_DEFAULT
  }

  const aiRole = policy.ai_role ?? null

  // Human-first: hold for a human up to the SLA before the AI may take over
  // (SLA enforcement is D2/D3 — here we only return the decision).
  if (policy.human_first) {
    return {
      owner: 'hold',
      reason: 'policy_human_first',
      policyId: policy.id,
      slaSeconds: policy.human_response_sla_seconds,
      aiRole,
    }
  }

  if (policy.owner === 'human') {
    return {
      owner: 'human',
      reason: 'policy_human',
      policyId: policy.id,
      slaSeconds: policy.human_response_sla_seconds,
      aiRole,
    }
  }

  if (policy.owner === 'hybrid') {
    const inHumanHours = isWithinHumanSchedule(
      policy.human_schedule as WeekSchedule | null,
      orgConfig.timezone,
      ctx.now
    )
    if (inHumanHours) {
      return {
        owner: 'human',
        reason: 'hybrid_human_hours',
        policyId: policy.id,
        slaSeconds: policy.human_response_sla_seconds,
        aiRole,
      }
    }
    return {
      owner: 'ai',
      reason: policy.human_schedule ? 'hybrid_ai_hours' : 'hybrid_no_schedule',
      policyId: policy.id,
      slaSeconds: null,
      aiRole,
    }
  }

  return { owner: 'ai', reason: 'policy_ai', policyId: policy.id, slaSeconds: null, aiRole }
}

/**
 * I/O wrapper: load policies + org toggles, then resolve.
 * Any load failure fails open to the legacy default (owner 'ai').
 */
export async function resolveAutomationOwner(
  supabase: SupabaseClient,
  ctx: AllocationContext
): Promise<AllocationDecision> {
  try {
    const [policies, { data: org }] = await Promise.all([
      loadPoliciesForOrg(supabase, ctx.organizationId),
      supabase
        .from('organizations')
        .select('timezone, human_first_sla_enabled, human_first_sla_seconds')
        .eq('id', ctx.organizationId)
        .single(),
    ])

    const orgConfig: AllocationOrgConfig = {
      timezone: (org?.timezone as string) || 'America/New_York',
      human_first_sla_enabled: org?.human_first_sla_enabled ?? false,
      human_first_sla_seconds: org?.human_first_sla_seconds ?? 180,
    }

    return resolveAllocation(policies, orgConfig, ctx)
  } catch (error) {
    logger.warn('Allocation: resolver failed, falling back to legacy default', {
      organizationId: ctx.organizationId,
      kind: ctx.kind,
      error: error instanceof Error ? error.message : String(error),
    })
    return LEGACY_DEFAULT
  }
}

// ── Internals ────────────────────────────────────────────────────────

/** Empty kinds array = the policy governs all kinds. */
function kindMatches(policy: AutomationPolicy, kind: AllocationKind): boolean {
  if (!policy.kinds || policy.kinds.length === 0) return true
  return policy.kinds.includes(kind)
}

/** Does the policy's scope target match the context being resolved? */
function scopeTargetMatches(policy: AutomationPolicy, ctx: AllocationContext): boolean {
  switch (policy.scope) {
    case 'org_default':
      return true
    case 'campaign':
      return (
        (policy.campaign_id != null && policy.campaign_id === ctx.campaignId) ||
        (policy.voice_campaign_id != null && policy.voice_campaign_id === ctx.voiceCampaignId)
      )
    case 'stage':
      return policy.stage_id != null && policy.stage_id === ctx.stageId
    case 'segment':
      return policy.smart_list_id != null && policy.smart_list_id === ctx.smartListId
    default:
      return false
  }
}

const DAY_NAMES: Array<keyof WeekSchedule> = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]

/**
 * Evaluate a hybrid policy's human_schedule in the org's local timezone.
 * Enabled day + local hour in [start, end) → HUMAN hours. Anything else
 * (disabled day, outside hours, missing/malformed schedule) → AI hours.
 */
function isWithinHumanSchedule(
  schedule: WeekSchedule | null,
  timezone: string,
  now?: Date
): boolean {
  if (!schedule) return false
  const { hour, day } = getLocalHourAndDay(timezone, now)
  const dayConfig = schedule[DAY_NAMES[day]] as DaySchedule | undefined
  if (!dayConfig?.enabled) return false
  return hour >= dayConfig.start && hour < dayConfig.end
}
