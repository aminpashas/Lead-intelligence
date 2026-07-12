import { describe, it, expect } from 'vitest'
import {
  buildRecommendations,
  evEligibleSignals,
  RECOMMENDATION_CONFIG,
  type PipelineSignals,
  type SegmentEv,
  type StageSignal,
} from './recommendations'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW_ISO = '2026-07-11T12:00:00.000Z'
const STALE_CUTOFF_ISO = '2026-07-04T12:00:00.000Z'

function makeStage(overrides: Partial<StageSignal> & { stageId: string }): StageSignal {
  return {
    stageName: overrides.stageId,
    slug: null,
    position: 0,
    kind: 'sales',
    total: 0,
    staleReachableSms: 0,
    hotWarmReachableSms: 0,
    neverContacted: 0,
    readyToBook: 0,
    deliberatingDue: 0,
    ...overrides,
  }
}

function makeSignals(stages: StageSignal[]): PipelineSignals {
  return { stages, staleCutoffIso: STALE_CUTOFF_ISO, nowIso: NOW_ISO, staleDays: 7 }
}

function ev(expectedValueUsd: number, avgCloseProbability = 0.2, leadCount = 0): SegmentEv {
  return { leadCount, expectedValueUsd, avgCloseProbability }
}

// ── Counts-only behavior (no EV fetched) ─────────────────────────────────────

describe('buildRecommendations without EV', () => {
  it('emits null EV fields and keeps the legacy count-based priority', () => {
    // strike_hot: base 70 + min(20, 10/5)*weight; single stage → weight 1.
    const recs = buildRecommendations(
      makeSignals([makeStage({ stageId: 'a', hotWarmReachableSms: 10 })])
    )
    expect(recs).toHaveLength(1)
    expect(recs[0].kind).toBe('strike_hot')
    expect(recs[0].priority).toBe(72) // 70 + 2*1
    expect(recs[0].expectedValueUsd).toBeNull()
    expect(recs[0].avgCloseProbability).toBeNull()
  })

  it('still populates deterministic count evidence', () => {
    const recs = buildRecommendations(
      makeSignals([makeStage({ stageId: 'a', deliberatingDue: 4 })])
    )
    expect(recs[0].evidence).toEqual([
      {
        metric: 'deliberating_due',
        value: 4,
        source: 'closing_temperature = deliberating AND closing_follow_up_at <= now',
      },
    ])
  })

  it('treats an explicit ev:null entry the same as no EV (graceful degrade)', () => {
    const withNull = buildRecommendations(
      makeSignals([
        makeStage({ stageId: 'a', hotWarmReachableSms: 10, ev: { hotWarmReachableSms: null } }),
      ])
    )
    const without = buildRecommendations(
      makeSignals([makeStage({ stageId: 'a', hotWarmReachableSms: 10 })])
    )
    expect(withNull).toEqual(without)
  })
})

// ── Dollar layer ─────────────────────────────────────────────────────────────

describe('buildRecommendations with EV', () => {
  it('appends expected-value evidence and carries the EV fields', () => {
    const recs = buildRecommendations(
      makeSignals([
        makeStage({
          stageId: 'a',
          hotWarmReachableSms: 10,
          ev: { hotWarmReachableSms: ev(84_500.4, 0.31, 10) },
        }),
      ])
    )
    expect(recs[0].expectedValueUsd).toBe(84_500.4)
    expect(recs[0].avgCloseProbability).toBe(0.31)
    expect(recs[0].evidence).toEqual([
      {
        metric: 'hot_warm_reachable_sms',
        value: 10,
        source: "ai_qualification in ('hot','warm') AND SMS-reachable",
      },
      {
        metric: 'expected_value_usd',
        value: 84_500, // rounded for the evidence fact
        source: 'pipeline_segment_ev · Σ close_probability × treatment_value',
      },
      {
        metric: 'avg_close_probability',
        value: 0.31,
        source: 'pipeline_segment_ev · mean calibrated close probability',
      },
    ])
  })

  it('lets a high-EV small segment outrank a low-EV big segment', () => {
    // Same kind + same stage weight so only counts and EV differ.
    // small: 70 + min(20, 5/5)*1.5 = 71.5 → 72 base; big: 70 + min(20, 25/5)*1.5 = 77.5 → 78.
    const small = makeStage({
      stageId: 'small',
      position: 1,
      hotWarmReachableSms: 5,
      ev: { hotWarmReachableSms: ev(500_000) },
    })
    const big = makeStage({
      stageId: 'big',
      position: 1,
      hotWarmReachableSms: 25,
      ev: { hotWarmReachableSms: ev(1_000) },
    })

    // Counts-only: the big segment wins.
    const withoutEv = buildRecommendations(
      makeSignals([
        makeStage({ stageId: 'small', position: 1, hotWarmReachableSms: 5 }),
        makeStage({ stageId: 'big', position: 1, hotWarmReachableSms: 25 }),
      ])
    )
    expect(withoutEv.map((r) => r.id)).toEqual(['strike_hot:big', 'strike_hot:small'])

    // With EV: +15 for the small (max-EV) segment vs ~+0 for the big one flips it.
    const withEv = buildRecommendations(makeSignals([small, big]))
    expect(withEv.map((r) => r.id)).toEqual(['strike_hot:small', 'strike_hot:big'])
    expect(withEv[0].priority).toBe(87) // 72 + 15 (full boost, largest EV in batch)
    expect(withEv[1].priority).toBe(78) // 78 + 15*(1000/500000) ≈ 78.03 → 78
  })

  it('scales the boost linearly by EV magnitude, capped at evBoostMax', () => {
    const recs = buildRecommendations(
      makeSignals([
        makeStage({
          stageId: 'top',
          position: 1,
          hotWarmReachableSms: 5,
          ev: { hotWarmReachableSms: ev(200_000) },
        }),
        makeStage({
          stageId: 'half',
          position: 1,
          hotWarmReachableSms: 5,
          ev: { hotWarmReachableSms: ev(100_000) },
        }),
      ])
    )
    const top = recs.find((r) => r.id === 'strike_hot:top')!
    const half = recs.find((r) => r.id === 'strike_hot:half')!
    // Both start at 72 (70 + 1*1.5 → 71.5 → 72); +15 vs +7.5.
    expect(top.priority).toBe(72 + RECOMMENDATION_CONFIG.evBoostMax)
    expect(half.priority).toBe(80) // 72 + 7.5 → 79.5 → 80
  })

  it('never pushes priority past 100', () => {
    const recs = buildRecommendations(
      makeSignals([
        makeStage({
          stageId: 'a',
          deliberatingDue: 100, // base 78 + capped 15 → 93
          ev: { deliberatingDue: ev(9_999_999) }, // +15 would be 108
        }),
      ])
    )
    expect(recs[0].priority).toBe(100)
  })

  it('breaks priority ties by EV descending', () => {
    const recs = buildRecommendations(
      makeSignals([
        makeStage({
          stageId: 'poor',
          position: 1,
          hotWarmReachableSms: 5,
          ev: { hotWarmReachableSms: ev(50_000) },
        }),
        makeStage({
          stageId: 'rich',
          position: 1,
          hotWarmReachableSms: 5,
          ev: { hotWarmReachableSms: ev(50_001) },
        }),
      ])
    )
    // Priorities round to the same value; the richer segment must lead.
    expect(recs[0].id).toBe('strike_hot:rich')
  })
})

// ── C3: execution descriptor ─────────────────────────────────────────────────

describe('execution descriptor', () => {
  // One signals fixture that fires every kind at least once.
  const signals = makeSignals([
    makeStage({
      stageId: 'sales-1',
      position: 1,
      slug: 'consult',
      hotWarmReachableSms: 10, // strike_hot
      staleReachableSms: 20, // follow_up
      deliberatingDue: 4, // follow_up_deliberating
      readyToBook: 6, // advance_stage (needs a next sales stage)
    }),
    makeStage({ stageId: 'sales-2', position: 2, slug: 'closing' }),
    makeStage({
      stageId: 'no-comm',
      kind: 'operational',
      slug: RECOMMENDATION_CONFIG.noCommunicationSlug,
      neverContacted: 30, // start_outreach
    }),
    makeStage({
      stageId: 'nurture',
      kind: 'operational',
      slug: 'nurturing',
      staleReachableSms: 20, // re_engage
    }),
  ])
  const recs = buildRecommendations(signals)
  const byKind = Object.fromEntries(recs.map((r) => [r.kind, r]))

  it('fires every kind in the fixture', () => {
    expect(Object.keys(byKind).sort()).toEqual([
      'advance_stage', 'follow_up', 'follow_up_deliberating',
      're_engage', 'start_outreach', 'strike_hot',
    ])
  })

  it.each([
    ['strike_hot', 'setter_ai', 'sms_broadcast', true, false, 500],
    ['follow_up_deliberating', 'closer_ai', 'sms_broadcast', true, false, 200],
    ['follow_up', 'setter_ai', 'sms_broadcast', true, false, 500],
    ['re_engage', 'setter_ai', 'sms_broadcast', true, false, 500],
    ['start_outreach', 'setter_ai', 'sms_broadcast', true, true, 1000],
    ['advance_stage', 'bulk_system', 'stage_move', false, false, 5000],
  ] as const)(
    '%s → executor %s, action %s',
    (kind, executor, action, consent, approval, maxLeads) => {
      const rec = byKind[kind]
      expect(rec.execution).toEqual({
        version: 1,
        executor,
        action,
        segment: rec.action.criteria,
        guardrails: {
          requiresConsentGate: consent,
          requiresHumanApproval: approval,
          maxLeads,
        },
      })
    }
  )

  it('carries the SAME segment criteria in execution and the UI action', () => {
    for (const rec of recs) {
      expect(rec.execution.segment).toBe(rec.action.criteria)
    }
  })
})

// ── EV-eligibility pre-pass (bounds the RPC fan-out) ─────────────────────────

describe('evEligibleSignals', () => {
  it('returns only signals whose counts clear their rule thresholds', () => {
    const s = makeStage({
      stageId: 'a',
      hotWarmReachableSms: RECOMMENDATION_CONFIG.minHotLeads, // at threshold → eligible
      staleReachableSms: RECOMMENDATION_CONFIG.minStaleLeads - 1, // below → not
      deliberatingDue: RECOMMENDATION_CONFIG.minDeliberatingDue,
      readyToBook: RECOMMENDATION_CONFIG.minReadyToBook - 1,
    })
    expect(evEligibleSignals(s)).toEqual(['deliberatingDue', 'hotWarmReachableSms'])
  })

  it('respects stage kind/slug gates', () => {
    // Operational stage: sales-only rules never fire regardless of counts.
    const ops = makeStage({
      stageId: 'ops',
      kind: 'operational',
      hotWarmReachableSms: 100,
      staleReachableSms: 100,
      deliberatingDue: 100,
      readyToBook: 100,
      neverContacted: 100,
    })
    expect(evEligibleSignals(ops)).toEqual([])

    // The no-communication queue is EV-eligible for start_outreach only.
    const noComm = makeStage({
      stageId: 'nc',
      kind: 'operational',
      slug: RECOMMENDATION_CONFIG.noCommunicationSlug,
      neverContacted: RECOMMENDATION_CONFIG.minNeverContacted,
    })
    expect(evEligibleSignals(noComm)).toEqual(['neverContacted'])

    // Nurture bucket is EV-eligible for re_engage (stale) only.
    const nurture = makeStage({
      stageId: 'n',
      kind: 'operational',
      slug: 'nurturing',
      staleReachableSms: RECOMMENDATION_CONFIG.minStaleLeads,
    })
    expect(evEligibleSignals(nurture)).toEqual(['staleReachableSms'])
  })
})
