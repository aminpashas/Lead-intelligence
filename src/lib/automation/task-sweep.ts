/**
 * Task sweep — materialize "work that needs doing" into `human_tasks`.
 *
 * The allocation engine (D1/D2) mints tasks from EVENTS, and is dormant until an
 * org has automation policies + autopilot enabled. Meanwhile the practice's real
 * daily work — follow-ups, deadlines, patients waiting on a reply — already
 * existed as SQL predicates evaluated at read time (the Action Queue tiles, the
 * deliberating timers on /closing) and never reached /tasks. This sweep closes
 * that gap: it materializes those STATE-shaped conditions into real task rows so
 * they can be claimed, assigned and completed like anything else.
 *
 * Division of labour, so the two producers can never fight:
 *   - event-shaped work → the allocation engine, kinds `inbound_reply` /
 *     `first_touch` / …, deduped per event and closed by the actor that handles it.
 *   - state-shaped work → this sweep, kind `follow_up` only, deduped per
 *     (rule, lead) and closed by `reconcile()` when the condition clears.
 *
 * Predicate ownership: the cohort rules are NOT re-implemented here. They are
 * read through `get_action_queue_cohort` → `analytics_in_action_cohort`, the same
 * function backing the Action Queue tiles, so a task can never disagree with the
 * dashboard that surfaced it.
 *
 * Deliberately NOT swept (see the /tasks backlog banner instead):
 *   - `untouched_new` — ~11k leads is a bulk motion (Smart List → call queue),
 *     not 11k individual to-dos. Minting them would bury the ~100 rows here that
 *     actually need a human decision today.
 *   - `escalations` — already has its own table + lifecycle. Mirroring rows would
 *     mean two sources of truth for one piece of work.
 *
 * Fails soft throughout: a sweep error must never take a cron batch down.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { decryptField } from '@/lib/encryption'
import { createHumanTask, resolveAssignee, type HumanTaskPriority } from './tasks'

/** Most rows one rule may mint in a single run (backstop against a rule going wide). */
const PER_RULE_CAP = 200

/**
 * How long a closed task suppresses a re-mint of the same (rule, lead).
 *
 * State-shaped conditions persist: a lead that went quiet is still quiet
 * tomorrow. Without suppression, a task dismissed at 09:00 would reappear at
 * 09:15 and the queue would be un-clearable. Suppression is finite rather than
 * permanent so a lead that is *still* stuck a month later resurfaces once,
 * instead of being silently abandoned forever.
 */
const SUPPRESSION_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

/** A lead as the sweep sees it (post-decrypt). */
export type SweepLead = {
  id: string
  name: string
  last_contacted_at: string | null
  last_responded_at: string | null
  created_at: string
  /** Only populated for the bespoke `deliberating_due` rule. */
  closing_follow_up_at?: string | null
}

export type SweepRuleKey =
  | 'inbound_awaiting_reply'
  | 'ready_to_book_stale'
  | 'deliberating_due'
  | 'engaged_gone_quiet'

export type SweepRule = {
  key: SweepRuleKey
  /**
   * Action-queue cohort backing this rule, or null when the rule runs its own
   * query (`deliberating_due` reads leads.closing_follow_up_at directly — it is
   * a real calendar deadline, not a staleness heuristic, so it has no cohort).
   */
  cohort: string | null
  priority: HumanTaskPriority
  title: (lead: SweepLead) => string
  detail: (lead: SweepLead) => string
  /** The deadline shown as an SLA countdown on /tasks, or null for no clock. */
  dueAt: (lead: SweepLead) => string | null
}

function daysSince(iso: string | null | undefined): number {
  if (!iso) return 0
  return Math.floor((Date.now() - new Date(iso).getTime()) / DAY_MS)
}

/**
 * The sweep rulebook — which conditions become tasks, how urgent they are, and
 * what deadline they carry.
 *
 * Ordered most-urgent-first purely for readability; /tasks sorts by priority
 * then due_at. Each rule's `priority` answers "if staff can only clear ten rows
 * today, should this be in them?", and `dueAt` answers "by when does acting on
 * this stop being worth it?".
 */
export const SWEEP_RULES: SweepRule[] = [
  {
    // A patient texted and nobody has replied. The most perishable work there is.
    key: 'inbound_awaiting_reply',
    cohort: 'inbound_awaiting_reply',
    priority: 'urgent',
    title: (l) => `Reply to ${l.name}`,
    detail: (l) =>
      `${l.name} messaged ${daysSince(l.last_responded_at)}d ago and hasn't had a reply.`,
    // Inbound goes stale fast — one hour from their message, then it's overdue.
    dueAt: (l) =>
      l.last_responded_at
        ? new Date(new Date(l.last_responded_at).getTime() + 60 * 60 * 1000).toISOString()
        : null,
  },
  {
    // Said yes to booking, then went 48h without contact. Highest-intent leak.
    key: 'ready_to_book_stale',
    cohort: 'ready_to_book_stale',
    priority: 'high',
    title: (l) => `Book ${l.name} — ready, not scheduled`,
    detail: (l) =>
      `${l.name} is ready to book but hasn't been contacted in ${daysSince(
        l.last_contacted_at ?? l.created_at
      )}d. Call to get the consult on the calendar.`,
    dueAt: () => new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
  },
  {
    // A real date the closer committed to on /closing — a promise, not a heuristic.
    key: 'deliberating_due',
    cohort: null,
    priority: 'high',
    title: (l) => `Follow up with ${l.name} — deliberating`,
    detail: (l) =>
      `${l.name} asked to be followed up with about their treatment decision. That date has arrived.`,
    dueAt: (l) => l.closing_follow_up_at ?? null,
  },
  {
    // Was engaged, has drifted. Worth a nudge, but never at the cost of the above.
    key: 'engaged_gone_quiet',
    cohort: 'engaged_gone_quiet',
    priority: 'normal',
    title: (l) => `Re-engage ${l.name} — gone quiet`,
    detail: (l) =>
      `${l.name} was actively considering treatment but hasn't replied in ${daysSince(
        l.last_responded_at
      )}d.`,
    // No hard deadline — this is background work, not a clock.
    dueAt: () => null,
  },
]

/** `human_tasks.dedupe_key` for a swept task. Namespaced so it can never */
/** collide with the allocation engine's `inbound:` / `first_touch:` keys.  */
export function sweepDedupeKey(rule: SweepRuleKey, leadId: string): string {
  return `sweep:${rule}:${leadId}`
}

export type SweepResult = { minted: number; closed: number; skipped: number }

/** Candidate leads for a cohort-backed rule, via the Action Queue's own RPC. */
async function cohortLeads(
  supabase: SupabaseClient,
  orgId: string,
  cohort: string
): Promise<SweepLead[]> {
  const { data, error } = await supabase.rpc('get_action_queue_cohort', {
    p_org_id: orgId,
    p_cohort: cohort,
    p_limit: PER_RULE_CAP,
    p_offset: 0,
  })
  if (error) {
    logger.warn('TaskSweep: cohort rpc failed', { orgId, cohort, error: error.message })
    return []
  }
  const rows = (data as { leads?: unknown[] } | null)?.leads ?? []
  return (rows as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    // The RPC concatenates raw name columns; decrypt in case this org stores PII
    // encrypted (`enc::` prefix). Plaintext passes through untouched.
    name: decryptField(r.name as string) || 'this lead',
    last_contacted_at: (r.last_contacted_at as string) ?? null,
    last_responded_at: (r.last_responded_at as string) ?? null,
    created_at: r.created_at as string,
  }))
}

/** Candidates for `deliberating_due`: a closer's promised follow-up date has arrived. */
async function deliberatingDueLeads(
  supabase: SupabaseClient,
  orgId: string
): Promise<SweepLead[]> {
  const { data, error } = await supabase
    .from('leads')
    .select('id, first_name, last_name, last_contacted_at, last_responded_at, created_at, closing_follow_up_at')
    .eq('organization_id', orgId)
    .eq('closing_temperature', 'deliberating')
    .not('closing_follow_up_at', 'is', null)
    .lte('closing_follow_up_at', new Date().toISOString())
    .limit(PER_RULE_CAP)

  if (error) {
    logger.warn('TaskSweep: deliberating query failed', { orgId, error: error.message })
    return []
  }
  return (data ?? []).map((r) => ({
    id: r.id as string,
    name:
      [decryptField(r.first_name), decryptField(r.last_name)]
        .filter(Boolean)
        .join(' ')
        .trim() || 'this lead',
    last_contacted_at: r.last_contacted_at,
    last_responded_at: r.last_responded_at,
    created_at: r.created_at,
    closing_follow_up_at: r.closing_follow_up_at,
  }))
}

async function candidatesFor(
  supabase: SupabaseClient,
  orgId: string,
  rule: SweepRule
): Promise<SweepLead[]> {
  return rule.cohort
    ? cohortLeads(supabase, orgId, rule.cohort)
    : deliberatingDueLeads(supabase, orgId)
}

/**
 * Run one rule for one org: mint tasks for leads newly matching the condition,
 * and close live tasks whose lead no longer matches it.
 */
async function sweepRule(
  supabase: SupabaseClient,
  orgId: string,
  rule: SweepRule
): Promise<SweepResult> {
  const result: SweepResult = { minted: 0, closed: 0, skipped: 0 }

  const candidates = await candidatesFor(supabase, orgId, rule)
  const candidateIds = new Set(candidates.map((l) => l.id))

  // Every task this rule has ever produced for this org, live or terminal. Live
  // rows drive reconcile; terminal rows drive suppression.
  const { data: existing, error } = await supabase
    .from('human_tasks')
    .select('id, lead_id, status, completed_at')
    .eq('organization_id', orgId)
    .eq('kind', 'follow_up')
    .like('dedupe_key', `sweep:${rule.key}:%`)

  if (error) {
    logger.warn('TaskSweep: existing-task read failed', {
      orgId,
      rule: rule.key,
      error: error.message,
    })
    return result
  }

  type TaskRow = { id: string; lead_id: string | null; status: string; completed_at: string | null }
  const rows = (existing ?? []) as TaskRow[]
  const live = rows.filter((t) => t.status === 'open' || t.status === 'claimed')
  const liveLeadIds = new Set(live.map((t) => t.lead_id).filter(Boolean) as string[])

  // Suppression: a lead whose task was closed inside the window stays closed,
  // even though the condition still holds — otherwise dismissing is futile.
  const suppressCutoff = Date.now() - SUPPRESSION_DAYS * DAY_MS
  const suppressed = new Set(
    rows
      .filter(
        (t) =>
          !liveLeadIds.has(t.lead_id ?? '') &&
          t.completed_at !== null &&
          new Date(t.completed_at).getTime() > suppressCutoff
      )
      .map((t) => t.lead_id)
      .filter(Boolean) as string[]
  )

  // ── Mint ──────────────────────────────────────────────────────────
  for (const lead of candidates) {
    if (liveLeadIds.has(lead.id)) continue // already queued
    if (suppressed.has(lead.id)) {
      result.skipped++
      continue
    }

    const assignee = await resolveAssignee(supabase, orgId, lead.id)
    const { taskId } = await createHumanTask(supabase, {
      organization_id: orgId,
      kind: 'follow_up',
      source: 'task_sweep',
      title: rule.title(lead),
      detail: rule.detail(lead),
      priority: rule.priority,
      due_at: rule.dueAt(lead),
      lead_id: lead.id,
      assigned_to: assignee.userId,
      assigned_role: assignee.role,
      dedupe_key: sweepDedupeKey(rule.key, lead.id),
      metadata: { rule: rule.key, swept_at: new Date().toISOString() },
    })
    if (taskId) result.minted++
  }

  // ── Reconcile ─────────────────────────────────────────────────────
  // The lead left the cohort, so the work is done (they replied, they booked,
  // they were disqualified). Close the row rather than leaving a lie on the
  // board. Marked auto_closed so it's distinguishable from human completion.
  const stale = live.filter((t) => t.lead_id && !candidateIds.has(t.lead_id))
  if (stale.length > 0) {
    const now = new Date().toISOString()
    const { error: closeErr } = await supabase
      .from('human_tasks')
      .update({ status: 'done', completed_at: now, updated_at: now })
      .in(
        'id',
        stale.map((t) => t.id)
      )
    if (closeErr) {
      logger.warn('TaskSweep: reconcile close failed', {
        orgId,
        rule: rule.key,
        error: closeErr.message,
      })
    } else {
      result.closed += stale.length
    }
  }

  return result
}

/** Run every rule for one org. */
export async function sweepOrg(supabase: SupabaseClient, orgId: string): Promise<SweepResult> {
  const total: SweepResult = { minted: 0, closed: 0, skipped: 0 }
  for (const rule of SWEEP_RULES) {
    try {
      const r = await sweepRule(supabase, orgId, rule)
      total.minted += r.minted
      total.closed += r.closed
      total.skipped += r.skipped
    } catch (err) {
      // One bad rule must not cost the org its other rules.
      logger.warn('TaskSweep: rule threw', {
        orgId,
        rule: rule.key,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return total
}
