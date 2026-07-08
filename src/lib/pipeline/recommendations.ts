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
}

export type PipelineSignals = {
  stages: StageSignal[]
  /** ISO cutoff: leads last contacted before this are "stale". */
  staleCutoffIso: string
  /** Human staleness window, e.g. 7, for copy ("7+ days"). */
  staleDays: number
}

export type RecommendationKind =
  | 'follow_up' // stale leads in an active sales stage → nudge
  | 'start_outreach' // never-contacted leads → first touch
  | 'strike_hot' // hot/warm leads sitting un-nudged → text now
  | 're_engage' // parked in Nurturing → win-back
  | 'advance_stage' // ready-to-book leads sitting too early → move forward

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
  /** Stable key (kind + stageId) — used for local "dismiss" persistence. */
  id: string
  kind: RecommendationKind
  /** 0–100 impact score; the band renders highest-priority first. */
  priority: number
  title: string
  detail: string
  /** Number of leads the action will target (== segment count). */
  leadCount: number
  /** Button label, e.g. "Send follow-up text". */
  cta: string
  action: RecommendationAction
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
  /** Base priority per kind before count/stage scaling. */
  basePriority: {
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
  return { stages: [stageId], has_phone: true, sms_consent: true }
}

/** The next sales stage forward from `s` by position, or undefined if last. */
function nextSalesStage(s: StageSignal, stages: StageSignal[]): StageSignal | undefined {
  return stages
    .filter((x) => x.kind === 'sales' && x.position > s.position)
    .sort((a, b) => a.position - b.position)[0]
}

/**
 * Turn stage signals into a prioritized, de-duplicated recommendation list.
 * Pure function — deterministic given the same signals.
 */
export function buildRecommendations(signals: PipelineSignals): Recommendation[] {
  const cfg = RECOMMENDATION_CONFIG
  const recs: Recommendation[] = []
  const maxPosition = signals.stages.reduce((m, s) => Math.max(m, s.position), 0)
  const isNurture = (slug: string | null) =>
    !!slug && cfg.nurtureSlugs.some((n) => slug.includes(n))

  for (const s of signals.stages) {
    const weight = stageWeight(s, maxPosition)

    // R1 — Strike while hot: high-intent leads in a sales stage that are
    // SMS-reachable and haven't been nudged. Most urgent because intent decays.
    if (s.kind === 'sales' && s.hotWarmReachableSms >= cfg.minHotLeads) {
      recs.push({
        id: `strike_hot:${s.stageId}`,
        kind: 'strike_hot',
        priority: clampPriority(
          cfg.basePriority.strike_hot + Math.min(20, s.hotWarmReachableSms / 5) * weight
        ),
        title: `Text ${s.hotWarmReachableSms.toLocaleString()} hot & warm leads in ${s.stageName}`,
        detail: `High-intent leads that are SMS-reachable and haven't been nudged. Reaching out while intent is fresh has the highest close lift.`,
        leadCount: s.hotWarmReachableSms,
        cta: 'Text hot leads now',
        action: {
          type: 'broadcast',
          channel: 'sms',
          segmentName: `Hot & warm · ${s.stageName}`,
          criteria: { ...reachableSmsBase(s.stageId), ai_qualifications: ['hot', 'warm'] },
        },
      })
    }

    // R2 — Follow up the stale: SMS-reachable leads in an active sales stage
    // with no contact in the staleness window.
    if (s.kind === 'sales' && s.staleReachableSms >= cfg.minStaleLeads) {
      recs.push({
        id: `follow_up:${s.stageId}`,
        kind: 'follow_up',
        priority: clampPriority(
          cfg.basePriority.follow_up + Math.min(25, s.staleReachableSms / 20) * weight
        ),
        title: `Follow up with ${s.staleReachableSms.toLocaleString()} cooling leads in ${s.stageName}`,
        detail: `No contact in ${signals.staleDays}+ days. A single well-timed follow-up text recovers a meaningful share of stalled deals before they go cold.`,
        leadCount: s.staleReachableSms,
        cta: 'Send follow-up text',
        action: {
          type: 'broadcast',
          channel: 'sms',
          segmentName: `Needs follow-up · ${s.stageName}`,
          criteria: {
            ...reachableSmsBase(s.stageId),
            last_contacted_before: signals.staleCutoffIso,
          },
        },
      })
    }

    // R3 — Start outreach: the never-contacted work queue is the single biggest
    // recoverable pool. First touch beats everything.
    if (s.slug === cfg.noCommunicationSlug && s.neverContacted >= cfg.minNeverContacted) {
      recs.push({
        id: `start_outreach:${s.stageId}`,
        kind: 'start_outreach',
        priority: clampPriority(
          cfg.basePriority.start_outreach + Math.min(30, s.neverContacted / 50)
        ),
        title: `Reach out to ${s.neverContacted.toLocaleString()} never-contacted leads`,
        detail: `These leads have never received a single message. Speed-to-lead is the highest-leverage lever you have — a first text today converts far better than one next week.`,
        leadCount: s.neverContacted,
        cta: 'Start outreach',
        action: {
          type: 'broadcast',
          channel: 'sms',
          segmentName: 'Never contacted',
          criteria: { ...reachableSmsBase(s.stageId), never_contacted: true },
        },
      })
    }

    // R5 — Advance the ready: leads the conversation sweep flagged ready-to-book
    // that are still parked in this sales stage belong further down the funnel.
    // A move backed by real intent — not a blanket push. Only fires when there
    // IS a next sales stage and enough flagged leads.
    if (s.kind === 'sales' && s.readyToBook >= cfg.minReadyToBook) {
      const next = nextSalesStage(s, signals.stages)
      if (next?.slug) {
        recs.push({
          id: `advance_stage:${s.stageId}`,
          kind: 'advance_stage',
          priority: clampPriority(
            cfg.basePriority.advance_stage + Math.min(20, s.readyToBook / 3) * weight
          ),
          title: `Advance ${s.readyToBook.toLocaleString()} ready-to-book leads to ${next.stageName}`,
          detail: `These leads signalled they're ready to book but are still in ${s.stageName}. Moving them to ${next.stageName} keeps the funnel honest and puts them in front of your closers.`,
          leadCount: s.readyToBook,
          cta: `Move to ${next.stageName}`,
          action: {
            type: 'bulk_stage',
            toStageSlug: next.slug,
            segmentName: `Ready to book · ${s.stageName}`,
            criteria: { stages: [s.stageId], conversation_intents: ['ready_to_book'] },
          },
        })
      }
    }

    // R4 — Win back: a parked Nurturing/dormant bucket worth re-engaging.
    if (isNurture(s.slug) && s.staleReachableSms >= cfg.minStaleLeads) {
      recs.push({
        id: `re_engage:${s.stageId}`,
        kind: 're_engage',
        priority: clampPriority(
          cfg.basePriority.re_engage + Math.min(15, s.staleReachableSms / 40)
        ),
        title: `Re-engage ${s.staleReachableSms.toLocaleString()} nurture leads in ${s.stageName}`,
        detail: `Parked and quiet for ${signals.staleDays}+ days. A win-back message revives the ones still in-market — cheaper than buying new leads.`,
        leadCount: s.staleReachableSms,
        cta: 'Send win-back text',
        action: {
          type: 'broadcast',
          channel: 'sms',
          segmentName: `Win-back · ${s.stageName}`,
          criteria: {
            ...reachableSmsBase(s.stageId),
            last_contacted_before: signals.staleCutoffIso,
          },
        },
      })
    }
  }

  return recs.sort((a, b) => b.priority - a.priority)
}
