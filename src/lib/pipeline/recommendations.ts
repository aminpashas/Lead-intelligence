import type { SmartListCriteria } from '@/types/database'

/**
 * Pipeline Recommendations Engine
 * ================================
 * The "AI agent" that powers the Google/Meta-Ads-style recommendation band atop
 * the Pipeline board. It is a DETERMINISTIC rules engine over stage-level
 * aggregate signals — not an LLM in the hot path. That is a deliberate v1 choice:
 *
 *   - It runs across the whole book (tens of thousands of leads) for free.
 *   - Every recommendation is explainable ("142 leads, 7+ days no contact") and
 *     reproducible — no hallucinated segments.
 *   - Each recommendation's `leadCount` equals the count of a REAL segment
 *     (`SmartListCriteria`), so "Apply" lands on exactly what was promised.
 *
 * An LLM can later be layered on top for phrasing/ranking without touching this
 * engine (see `smart-outreach.ts` for message drafting).
 *
 * This module is pure (no I/O) so it unit-tests without mocks. Signals are
 * gathered in `pipeline-signals.ts`.
 */

/** Dollar-ranked expected value for one stage+signal segment, from the
 *  `pipeline_segment_ev` RPC (Workstream C1). `expectedValueUsd` is
 *  Σ close_probability × treatment_value over the segment (with org-level
 *  fallbacks for unstamped/unlinked leads); `leadCount` is the RPC's own count
 *  of the same segment (may drift slightly from the head-count if leads moved
 *  between the two queries — the head-count stays authoritative for copy). */
export type SegmentEv = {
  leadCount: number
  expectedValueUsd: number
  avgCloseProbability: number
}

/** The StageSignal count fields that can carry an EV annotation. */
export type SignalEvKey =
  | 'staleReachableSms'
  | 'hotWarmReachableSms'
  | 'neverContacted'
  | 'readyToBook'
  | 'deliberatingDue'

/** A single explainability fact attached to a recommendation. */
export type RecommendationEvidence = {
  metric: string
  value: number | string
  source: string
}

/** Aggregate signals for one pipeline stage, computed server-side. */
export type StageSignal = {
  stageId: string
  stageName: string
  slug: string | null
  position: number
  /** 'sales' = deal moving toward close; 'operational' = work-queue bucket
   *  (No Communication / Nurturing / DND SMS). Different rules apply. */
  kind: 'sales' | 'operational'
  /** Exact total leads in the stage (treatment-filtered when a service is active). */
  total: number
  /** SMS-reachable leads with no contact in the staleness window (or never
   *  contacted). The core "needs follow-up" population. */
  staleReachableSms: number
  /** SMS-reachable hot/warm leads — high-intent, worth an immediate nudge. */
  hotWarmReachableSms: number
  /** Leads never contacted at all (last_contacted_at IS NULL). */
  neverContacted: number
  /** Leads the conversation-analysis sweep flagged as ready to book — a real
   *  signal that they belong further down the funnel. */
  readyToBook: number
  /** SMS-reachable deliberating deals whose follow-up date has ARRIVED (dated &
   *  due). The closer agreed to circle back and today is the day. */
  deliberatingDue: number
  /** Optional dollar layer per signal (from `pipeline_segment_ev`). Absent or
   *  null when the RPC isn't available / failed / a service chip is active —
   *  the engine then behaves exactly as the counts-only version. */
  ev?: Partial<Record<SignalEvKey, SegmentEv | null>>
}

export type PipelineSignals = {
  stages: StageSignal[]
  /** ISO cutoff: leads last contacted before this are "stale". */
  staleCutoffIso: string
  /** ISO "now" — the boundary for deliberating deals coming due. */
  nowIso: string
  /** Human staleness window, e.g. 7, for copy ("7+ days"). */
  staleDays: number
}

export type RecommendationKind =
  | 'follow_up' // stale leads in an active sales stage → nudge
  | 'start_outreach' // never-contacted leads → first touch
  | 'strike_hot' // hot/warm leads sitting un-nudged → text now
  | 're_engage' // parked in Nurturing → win-back
  | 'advance_stage' // ready-to-book leads sitting too early → move forward
  | 'follow_up_deliberating' // deliberating deals whose follow-up date has arrived

/** Every kind a Recommendation row can carry. The rules engine emits only
 *  RecommendationKind; the LLM analyst (Workstream C2) adds 'analyst_insight'
 *  rows when persisting to pipeline_recommendations. */
export type AnyRecommendationKind = RecommendationKind | 'analyst_insight'

// ── C3: execution descriptor ──────────────────────────────────────────────────
// A machine-readable statement of WHO should execute a recommendation and HOW,
// decoupled from the UI `action` (which describes the review hand-off surface).
// Downstream automation (setter/closer agents, bulk systems) reads this instead
// of parsing titles. Deterministic per kind — see EXECUTION_BY_KIND.

export type RecommendationExecutor = 'setter_ai' | 'closer_ai' | 'human_task' | 'bulk_system'
export type RecommendationExecutionAction = 'sms_broadcast' | 'stage_move' | 'call_task' | 'review'

export type RecommendationExecution = {
  version: 1
  executor: RecommendationExecutor
  action: RecommendationExecutionAction
  /** The exact segment the executor operates on (same criteria as `action`). */
  segment: SmartListCriteria
  guardrails: {
    /** Outbound messaging must pass the consent/A2P gate before sending. */
    requiresConsentGate: boolean
    /** A human must approve before the executor may act. */
    requiresHumanApproval: boolean
    /** Hard ceiling on leads touched in one execution. */
    maxLeads: number
  }
}

/** Deterministic executor/guardrail policy per kind. TUNE ME alongside
 *  RECOMMENDATION_CONFIG — same "sales judgment lives in one block" rule. */
const EXECUTION_BY_KIND: Record<
  RecommendationKind,
  Omit<RecommendationExecution, 'version' | 'segment'>
> = {
  // Hot leads: the setter AI texts them — consent-gated, no approval needed.
  strike_hot: {
    executor: 'setter_ai',
    action: 'sms_broadcast',
    guardrails: { requiresConsentGate: true, requiresHumanApproval: false, maxLeads: 500 },
  },
  // Due deliberating deals are a CLOSER conversation, not a setter blast.
  follow_up_deliberating: {
    executor: 'closer_ai',
    action: 'sms_broadcast',
    guardrails: { requiresConsentGate: true, requiresHumanApproval: false, maxLeads: 200 },
  },
  follow_up: {
    executor: 'setter_ai',
    action: 'sms_broadcast',
    guardrails: { requiresConsentGate: true, requiresHumanApproval: false, maxLeads: 500 },
  },
  re_engage: {
    executor: 'setter_ai',
    action: 'sms_broadcast',
    guardrails: { requiresConsentGate: true, requiresHumanApproval: false, maxLeads: 500 },
  },
  // First touch to a large cold pool: big blast radius → human approves first.
  start_outreach: {
    executor: 'setter_ai',
    action: 'sms_broadcast',
    guardrails: { requiresConsentGate: true, requiresHumanApproval: true, maxLeads: 1000 },
  },
  // Stage moves send nothing — no consent gate; cap mirrors AUTO_APPLY_CAP.
  advance_stage: {
    executor: 'bulk_system',
    action: 'stage_move',
    guardrails: { requiresConsentGate: false, requiresHumanApproval: false, maxLeads: 5000 },
  },
}

/** Build the C3 descriptor for a rules-engine kind + segment. Pure. */
export function buildExecution(
  kind: RecommendationKind,
  segment: SmartListCriteria
): RecommendationExecution {
  return { version: 1, segment, ...EXECUTION_BY_KIND[kind] }
}

/** What "Apply" does. All actions are review-first: they materialize a segment
 *  and hand off to an existing tool for the human to confirm. */
export type RecommendationAction =
  | {
      type: 'broadcast'
      channel: 'sms'
      /** Name for the Smart List that gets created/reused on Apply. */
      segmentName: string
      criteria: SmartListCriteria
    }
  | {
      type: 'bulk_stage'
      /** Slug of the stage leads should be moved to (resolved to id on Apply). */
      toStageSlug: string
      segmentName: string
      criteria: SmartListCriteria
    }

export type Recommendation = {
  /** Stable key (kind + stageId) — doubles as the persisted row's dedupe_key. */
  id: string
  kind: AnyRecommendationKind
  /** 0–100 impact score; the band renders highest-priority first. */
  priority: number
  title: string
  detail: string
  /** Number of leads the action will target (== segment count). */
  leadCount: number
  /** Button label, e.g. "Send follow-up text". */
  cta: string
  action: RecommendationAction
  /** Σ close_probability × treatment_value over the segment (org fallbacks for
   *  missing values). Null when EV wasn't fetched — counts-only behavior. */
  expectedValueUsd: number | null
  /** Mean (fallback-filled) close probability across the segment, 0..1. */
  avgCloseProbability: number | null
  /** Deterministic explainability facts: the count that fired the rule plus,
   *  when present, the dollar expected value backing the priority boost. */
  evidence: RecommendationEvidence[]
  /** C3: who executes this and under which guardrails (machine-readable). */
  execution: RecommendationExecution
}

/**
 * TUNE ME. These thresholds and weights encode sales judgment — the kind of
 * thing that varies per practice. Everything below reads from this block so you
 * can adjust behaviour without touching rule logic.
 */
export const RECOMMENDATION_CONFIG = {
  /** Don't surface a follow-up rec below this many stale leads (avoids noise). */
  minStaleLeads: 15,
  /** Don't surface a "strike hot" rec below this many hot/warm leads. */
  minHotLeads: 5,
  /** Don't surface a "start outreach" rec below this many never-contacted leads. */
  minNeverContacted: 25,
  /** Don't surface an "advance stage" rec below this many ready-to-book leads. */
  minReadyToBook: 5,
  /** Deliberating deals are precious and time-sensitive — surface even a few. */
  minDeliberatingDue: 3,
  /** Base priority per kind before count/stage scaling. */
  basePriority: {
    follow_up_deliberating: 78, // agreed follow-up coming due — a promise to keep, highest lift
    strike_hot: 70, // high intent, decaying fast — most urgent
    advance_stage: 60, // clear evidence they should move — act on it
    follow_up: 45,
    start_outreach: 40,
    re_engage: 25,
  } as Record<RecommendationKind, number>,
  /** Slugs (or name regex) treated as the win-back / nurture bucket. */
  nurtureSlugs: ['nurturing', 'dormant', 'cold'],
  /** Slug of the never-contacted work queue. */
  noCommunicationSlug: 'no-communication',
  /** Terminal outcome stages (Lost / No-Show). They sit at the end of the
   *  position order but are NOT forward progress — advance_stage must never
   *  pick one as a move target (the engine once recommended "advance
   *  ready-to-book leads to Lost"). */
  terminalSlugs: ['lost', 'no-show'],
  /** Lead statuses barred from every recommendation segment. A disqualified or
   *  unresponsive lead may still carry a stage/intent/heat signal, but it is
   *  not actionable — including them made segments read as contradictions
   *  ("ready to book" lists full of Disqualified pills). Mirrored by the
   *  signal counts in pipeline-signals.ts so counts == segment size. */
  excludeStatuses: ['disqualified', 'unresponsive'],
  /** Max extra priority points a recommendation can earn from expected value.
   *  See applyEvBoost for the formula. */
  evBoostMax: 15,
} as const

/** Clamp to 0–100 and round for a stable sort/display. */
function clampPriority(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)))
}

/**
 * Later sales stages have more money at risk, so a stale lead there is worth
 * more attention. Scales roughly 1.0 → 1.5 across the funnel by position.
 */
function stageWeight(s: StageSignal, maxPosition: number): number {
  if (s.kind !== 'sales' || maxPosition <= 0) return 1
  return 1 + (s.position / maxPosition) * 0.5
}

/** Base SMS-eligibility criteria shared by every broadcast recommendation. */
function reachableSmsBase(stageId: string): SmartListCriteria {
  return {
    stages: [stageId],
    has_phone: true,
    sms_consent: true,
    exclude_statuses: [...RECOMMENDATION_CONFIG.excludeStatuses],
  }
}

/** True when the stage is a terminal outcome bucket (Lost / No-Show). */
function isTerminalStage(slug: string | null): boolean {
  return !!slug && (RECOMMENDATION_CONFIG.terminalSlugs as readonly string[]).includes(slug)
}

/** The next sales stage forward from `s` by position, or undefined if none.
 *  Terminal stages (Lost / No-Show) are never a valid advance target. */
function nextSalesStage(s: StageSignal, stages: StageSignal[]): StageSignal | undefined {
  return stages
    .filter((x) => x.kind === 'sales' && x.position > s.position && !isTerminalStage(x.slug))
    .sort((a, b) => a.position - b.position)[0]
}

/** True when the stage is the win-back / nurture bucket (shared by R4 and the
 *  EV-eligibility pre-pass so they can't drift apart). */
function isNurtureStage(slug: string | null): boolean {
  return !!slug && RECOMMENDATION_CONFIG.nurtureSlugs.some((n) => slug.includes(n))
}

/**
 * Which of a stage's signals would actually fire a rule at current counts —
 * i.e. the only stage/signal pairs worth an EV RPC round-trip. Mirrors the rule
 * guards in buildRecommendations (kind/slug gate + min-count threshold) so the
 * signal gatherer never queries EV for a segment that can't surface. Kept here
 * (not in pipeline-signals.ts) so thresholds and eligibility live in one file.
 * Note: readyToBook slightly over-fetches when no next sales stage exists —
 * acceptable; the topology check needs the full stage list.
 */
export function evEligibleSignals(s: StageSignal): SignalEvKey[] {
  const cfg = RECOMMENDATION_CONFIG
  const keys: SignalEvKey[] = []
  if (s.kind === 'sales' && s.deliberatingDue >= cfg.minDeliberatingDue) keys.push('deliberatingDue')
  if (s.kind === 'sales' && s.hotWarmReachableSms >= cfg.minHotLeads) keys.push('hotWarmReachableSms')
  if (
    (s.kind === 'sales' || isNurtureStage(s.slug)) &&
    s.staleReachableSms >= cfg.minStaleLeads
  ) {
    keys.push('staleReachableSms')
  }
  if (s.slug === cfg.noCommunicationSlug && s.neverContacted >= cfg.minNeverContacted) {
    keys.push('neverContacted')
  }
  if (s.kind === 'sales' && !isTerminalStage(s.slug) && s.readyToBook >= cfg.minReadyToBook) {
    keys.push('readyToBook')
  }
  return keys
}

/** The primary count fact plus, when EV was fetched, the dollar facts. */
function buildEvidence(
  primary: RecommendationEvidence,
  ev: SegmentEv | null
): RecommendationEvidence[] {
  if (!ev) return [primary]
  return [
    primary,
    {
      metric: 'expected_value_usd',
      value: Math.round(ev.expectedValueUsd),
      source: 'pipeline_segment_ev · Σ close_probability × treatment_value',
    },
    {
      metric: 'avg_close_probability',
      value: ev.avgCloseProbability,
      source: 'pipeline_segment_ev · mean calibrated close probability',
    },
  ]
}

/**
 * EV boost (Workstream C1): recommendations that carry a dollar expected value
 * earn up to `evBoostMax` (+15) extra priority points, scaled LINEARLY by
 * magnitude relative to the batch's largest EV:
 *
 *     boost(rec) = evBoostMax × (rec.expectedValueUsd / max EV in batch)
 *
 * So the highest-EV recommendation gets the full +15, the rest a proportional
 * share, and null/zero-EV recommendations get 0 — when no EV was fetched the
 * engine is bit-identical to the counts-only version. Counts stay authoritative
 * in title/detail; EV reorders and is displayed alongside. Mutates in place
 * (recs are freshly built by the caller).
 */
function applyEvBoost(recs: Recommendation[]): void {
  const maxEv = recs.reduce((m, r) => Math.max(m, r.expectedValueUsd ?? 0), 0)
  if (maxEv <= 0) return
  for (const r of recs) {
    if (r.expectedValueUsd != null && r.expectedValueUsd > 0) {
      r.priority = clampPriority(
        r.priority + RECOMMENDATION_CONFIG.evBoostMax * (r.expectedValueUsd / maxEv)
      )
    }
  }
}

/**
 * Turn stage signals into a prioritized, de-duplicated recommendation list.
 * Pure function — deterministic given the same signals.
 */
export function buildRecommendations(signals: PipelineSignals): Recommendation[] {
  const cfg = RECOMMENDATION_CONFIG
  const recs: Recommendation[] = []
  const maxPosition = signals.stages.reduce((m, s) => Math.max(m, s.position), 0)

  for (const s of signals.stages) {
    const weight = stageWeight(s, maxPosition)

    // R0 — Due follow-ups: deliberating deals whose agreed follow-up date has
    // arrived. Highest lift of any rec — the patient chose to keep talking and
    // today is the day, so a nudge lands on the warmest, most explicit intent
    // we track. Fires only in sales stages (deliberating is a closing state).
    if (s.kind === 'sales' && s.deliberatingDue >= cfg.minDeliberatingDue) {
      const ev = s.ev?.deliberatingDue ?? null
      const criteria: SmartListCriteria = {
        ...reachableSmsBase(s.stageId),
        closing_temperatures: ['deliberating'],
        closing_follow_up_before: signals.nowIso,
      }
      recs.push({
        id: `follow_up_deliberating:${s.stageId}`,
        kind: 'follow_up_deliberating',
        execution: buildExecution('follow_up_deliberating', criteria),
        priority: clampPriority(
          cfg.basePriority.follow_up_deliberating + Math.min(15, s.deliberatingDue / 2) * weight
        ),
        expectedValueUsd: ev?.expectedValueUsd ?? null,
        avgCloseProbability: ev?.avgCloseProbability ?? null,
        evidence: buildEvidence(
          {
            metric: 'deliberating_due',
            value: s.deliberatingDue,
            source: 'closing_temperature = deliberating AND closing_follow_up_at <= now',
          },
          ev
        ),
        title: `Follow up with ${s.deliberatingDue.toLocaleString()} deliberating leads in ${s.stageName}`,
        detail: `These deals were parked to circle back and the follow-up date has arrived. They saw the plan and asked for time — reaching out on the day you agreed is the highest-intent, best-timed touch you have.`,
        leadCount: s.deliberatingDue,
        cta: 'Reach out now',
        action: {
          type: 'broadcast',
          channel: 'sms',
          segmentName: `Due follow-up · ${s.stageName}`,
          criteria,
        },
      })
    }

    // R1 — Strike while hot: high-intent leads in a sales stage that are
    // SMS-reachable and haven't been nudged. Most urgent because intent decays.
    if (s.kind === 'sales' && s.hotWarmReachableSms >= cfg.minHotLeads) {
      const ev = s.ev?.hotWarmReachableSms ?? null
      const criteria: SmartListCriteria = {
        ...reachableSmsBase(s.stageId),
        ai_qualifications: ['hot', 'warm'],
      }
      recs.push({
        id: `strike_hot:${s.stageId}`,
        kind: 'strike_hot',
        execution: buildExecution('strike_hot', criteria),
        priority: clampPriority(
          cfg.basePriority.strike_hot + Math.min(20, s.hotWarmReachableSms / 5) * weight
        ),
        expectedValueUsd: ev?.expectedValueUsd ?? null,
        avgCloseProbability: ev?.avgCloseProbability ?? null,
        evidence: buildEvidence(
          {
            metric: 'hot_warm_reachable_sms',
            value: s.hotWarmReachableSms,
            source: "ai_qualification in ('hot','warm') AND SMS-reachable",
          },
          ev
        ),
        title: `Text ${s.hotWarmReachableSms.toLocaleString()} hot & warm leads in ${s.stageName}`,
        detail: `High-intent leads that are SMS-reachable and haven't been nudged. Reaching out while intent is fresh has the highest close lift.`,
        leadCount: s.hotWarmReachableSms,
        cta: 'Text hot leads now',
        action: {
          type: 'broadcast',
          channel: 'sms',
          segmentName: `Hot & warm · ${s.stageName}`,
          criteria,
        },
      })
    }

    // R2 — Follow up the stale: SMS-reachable leads in an active sales stage
    // with no contact in the staleness window.
    if (s.kind === 'sales' && s.staleReachableSms >= cfg.minStaleLeads) {
      const ev = s.ev?.staleReachableSms ?? null
      const criteria: SmartListCriteria = {
        ...reachableSmsBase(s.stageId),
        last_contacted_before: signals.staleCutoffIso,
      }
      recs.push({
        id: `follow_up:${s.stageId}`,
        kind: 'follow_up',
        execution: buildExecution('follow_up', criteria),
        priority: clampPriority(
          cfg.basePriority.follow_up + Math.min(25, s.staleReachableSms / 20) * weight
        ),
        expectedValueUsd: ev?.expectedValueUsd ?? null,
        avgCloseProbability: ev?.avgCloseProbability ?? null,
        evidence: buildEvidence(
          {
            metric: 'stale_reachable_sms',
            value: s.staleReachableSms,
            source: `no contact since ${signals.staleCutoffIso} (${signals.staleDays}d window) AND SMS-reachable`,
          },
          ev
        ),
        title: `Follow up with ${s.staleReachableSms.toLocaleString()} cooling leads in ${s.stageName}`,
        detail: `No contact in ${signals.staleDays}+ days. A single well-timed follow-up text recovers a meaningful share of stalled deals before they go cold.`,
        leadCount: s.staleReachableSms,
        cta: 'Send follow-up text',
        action: {
          type: 'broadcast',
          channel: 'sms',
          segmentName: `Needs follow-up · ${s.stageName}`,
          criteria,
        },
      })
    }

    // R3 — Start outreach: the never-contacted work queue is the single biggest
    // recoverable pool. First touch beats everything.
    if (s.slug === cfg.noCommunicationSlug && s.neverContacted >= cfg.minNeverContacted) {
      const ev = s.ev?.neverContacted ?? null
      const criteria: SmartListCriteria = {
        ...reachableSmsBase(s.stageId),
        never_contacted: true,
      }
      recs.push({
        id: `start_outreach:${s.stageId}`,
        kind: 'start_outreach',
        execution: buildExecution('start_outreach', criteria),
        priority: clampPriority(
          cfg.basePriority.start_outreach + Math.min(30, s.neverContacted / 50)
        ),
        expectedValueUsd: ev?.expectedValueUsd ?? null,
        avgCloseProbability: ev?.avgCloseProbability ?? null,
        evidence: buildEvidence(
          {
            metric: 'never_contacted',
            value: s.neverContacted,
            source: 'last_contacted_at IS NULL AND SMS-reachable',
          },
          ev
        ),
        title: `Reach out to ${s.neverContacted.toLocaleString()} never-contacted leads`,
        detail: `These leads have never received a single message. Speed-to-lead is the highest-leverage lever you have — a first text today converts far better than one next week.`,
        leadCount: s.neverContacted,
        cta: 'Start outreach',
        action: {
          type: 'broadcast',
          channel: 'sms',
          segmentName: 'Never contacted',
          criteria,
        },
      })
    }

    // R5 — Advance the ready: leads the conversation sweep flagged ready-to-book
    // that are still parked in this sales stage belong further down the funnel.
    // A move backed by real intent — not a blanket push. Only fires when there
    // IS a next sales stage and enough flagged leads. Terminal stages (Lost /
    // No-Show) are excluded as a source: a ready-to-book lead sitting in Lost
    // is a win-back conversation, not a bulk stage-move.
    if (s.kind === 'sales' && !isTerminalStage(s.slug) && s.readyToBook >= cfg.minReadyToBook) {
      const next = nextSalesStage(s, signals.stages)
      if (next?.slug) {
        const ev = s.ev?.readyToBook ?? null
        const criteria: SmartListCriteria = {
          stages: [s.stageId],
          conversation_intents: ['ready_to_book'],
          exclude_statuses: [...RECOMMENDATION_CONFIG.excludeStatuses],
        }
        recs.push({
          id: `advance_stage:${s.stageId}`,
          kind: 'advance_stage',
          execution: buildExecution('advance_stage', criteria),
          priority: clampPriority(
            cfg.basePriority.advance_stage + Math.min(20, s.readyToBook / 3) * weight
          ),
          expectedValueUsd: ev?.expectedValueUsd ?? null,
          avgCloseProbability: ev?.avgCloseProbability ?? null,
          evidence: buildEvidence(
            {
              metric: 'ready_to_book',
              value: s.readyToBook,
              source: "conversation_intent = 'ready_to_book'",
            },
            ev
          ),
          title: `Advance ${s.readyToBook.toLocaleString()} ready-to-book leads to ${next.stageName}`,
          detail: `These leads signalled they're ready to book but are still in ${s.stageName}. Moving them to ${next.stageName} keeps the funnel honest and puts them in front of your closers.`,
          leadCount: s.readyToBook,
          cta: `Move to ${next.stageName}`,
          action: {
            type: 'bulk_stage',
            toStageSlug: next.slug,
            segmentName: `Ready to book · ${s.stageName}`,
            criteria,
          },
        })
      }
    }

    // R4 — Win back: a parked Nurturing/dormant bucket worth re-engaging.
    if (isNurtureStage(s.slug) && s.staleReachableSms >= cfg.minStaleLeads) {
      const ev = s.ev?.staleReachableSms ?? null
      const criteria: SmartListCriteria = {
        ...reachableSmsBase(s.stageId),
        last_contacted_before: signals.staleCutoffIso,
      }
      recs.push({
        id: `re_engage:${s.stageId}`,
        kind: 're_engage',
        execution: buildExecution('re_engage', criteria),
        priority: clampPriority(
          cfg.basePriority.re_engage + Math.min(15, s.staleReachableSms / 40)
        ),
        expectedValueUsd: ev?.expectedValueUsd ?? null,
        avgCloseProbability: ev?.avgCloseProbability ?? null,
        evidence: buildEvidence(
          {
            metric: 'stale_reachable_sms',
            value: s.staleReachableSms,
            source: `nurture bucket, no contact since ${signals.staleCutoffIso} (${signals.staleDays}d window) AND SMS-reachable`,
          },
          ev
        ),
        title: `Re-engage ${s.staleReachableSms.toLocaleString()} nurture leads in ${s.stageName}`,
        detail: `Parked and quiet for ${signals.staleDays}+ days. A win-back message revives the ones still in-market — cheaper than buying new leads.`,
        leadCount: s.staleReachableSms,
        cta: 'Send win-back text',
        action: {
          type: 'broadcast',
          channel: 'sms',
          segmentName: `Win-back · ${s.stageName}`,
          criteria,
        },
      })
    }
  }

  // Dollar layer: nudge priorities by expected value (no-op when EV absent),
  // then sort. EV desc breaks priority ties so ranking stays deterministic.
  applyEvBoost(recs)
  return recs.sort(
    (a, b) =>
      b.priority - a.priority || (b.expectedValueUsd ?? 0) - (a.expectedValueUsd ?? 0)
  )
}
