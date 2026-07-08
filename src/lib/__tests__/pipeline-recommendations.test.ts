import { describe, it, expect } from 'vitest'
import {
  buildRecommendations,
  RECOMMENDATION_CONFIG as CFG,
  type PipelineSignals,
  type StageSignal,
} from '@/lib/pipeline/recommendations'

const sig = (o: Partial<StageSignal>): StageSignal => ({
  stageId: 'x', stageName: 'X', slug: 'x', position: 0, kind: 'sales',
  total: 0, staleReachableSms: 0, hotWarmReachableSms: 0, neverContacted: 0,
  readyToBook: 0, deliberatingDue: 0, ...o,
})

const NOW_ISO = '2026-07-08T12:00:00.000Z'
const signals = (stages: StageSignal[]): PipelineSignals => ({
  stages, staleCutoffIso: '2026-07-01T00:00:00.000Z', nowIso: NOW_ISO, staleDays: 7,
})

describe('buildRecommendations', () => {
  it('emits a follow-up rec for a sales stage with enough stale leads', () => {
    const recs = buildRecommendations(
      signals([sig({ stageId: 'consult', stageName: 'Consultation', staleReachableSms: 120 })])
    )
    const followUp = recs.find((r) => r.kind === 'follow_up')
    expect(followUp).toBeDefined()
    expect(followUp!.leadCount).toBe(120)
    // The Apply segment must target the same stage + stale window it advertises.
    expect(followUp!.action).toMatchObject({
      type: 'broadcast',
      criteria: { stages: ['consult'], last_contacted_before: '2026-07-01T00:00:00.000Z' },
    })
  })

  it('stays silent below the stale threshold (no noise)', () => {
    const recs = buildRecommendations(
      signals([sig({ staleReachableSms: CFG.minStaleLeads - 1 })])
    )
    expect(recs.some((r) => r.kind === 'follow_up')).toBe(false)
  })

  it('recommends first-touch outreach for the never-contacted work queue', () => {
    const recs = buildRecommendations(
      signals([sig({ stageId: 'nc', slug: 'no-communication', kind: 'operational', neverContacted: 5000 })])
    )
    const outreach = recs.find((r) => r.kind === 'start_outreach')
    expect(outreach).toBeDefined()
    expect(outreach!.action).toMatchObject({ criteria: { never_contacted: true } })
  })

  it('advances ready-to-book leads to the NEXT sales stage', () => {
    const recs = buildRecommendations(
      signals([
        sig({ stageId: 'consult', stageName: 'Consultation', slug: 'consultation', position: 1, readyToBook: 20 }),
        sig({ stageId: 'fin', stageName: 'Financing', slug: 'financing', position: 2 }),
      ])
    )
    const move = recs.find((r) => r.kind === 'advance_stage')
    expect(move).toBeDefined()
    expect(move!.action).toMatchObject({ type: 'bulk_stage', toStageSlug: 'financing' })
  })

  it('does not advance from the last sales stage (no next stage)', () => {
    const recs = buildRecommendations(
      signals([sig({ stageId: 'fin', slug: 'financing', position: 9, readyToBook: 50 })])
    )
    expect(recs.some((r) => r.kind === 'advance_stage')).toBe(false)
  })

  it('sorts by priority (hot leads outrank a smaller follow-up pool)', () => {
    const recs = buildRecommendations(
      signals([
        sig({ stageId: 'a', hotWarmReachableSms: 40 }),
        sig({ stageId: 'b', staleReachableSms: 30 }),
      ])
    )
    expect(recs[0].kind).toBe('strike_hot')
    expect(recs).toEqual([...recs].sort((x, y) => y.priority - x.priority))
  })

  it('surfaces deliberating deals that have come due, targeting the exact segment', () => {
    const recs = buildRecommendations(
      signals([sig({ stageId: 'tp', stageName: 'Treatment Presented', deliberatingDue: 9 })])
    )
    const due = recs.find((r) => r.kind === 'follow_up_deliberating')
    expect(due).toBeDefined()
    expect(due!.leadCount).toBe(9)
    // Count == segment: same stage, deliberating, due at/ before now, SMS-reachable.
    expect(due!.action).toMatchObject({
      type: 'broadcast',
      criteria: {
        stages: ['tp'],
        has_phone: true,
        sms_consent: true,
        closing_temperatures: ['deliberating'],
        closing_follow_up_before: NOW_ISO,
      },
    })
  })

  it('stays silent below the deliberating-due threshold', () => {
    const recs = buildRecommendations(
      signals([sig({ deliberatingDue: CFG.minDeliberatingDue - 1 })])
    )
    expect(recs.some((r) => r.kind === 'follow_up_deliberating')).toBe(false)
  })

  it('ranks a due deliberating follow-up above strike-hot (highest lift)', () => {
    const recs = buildRecommendations(
      signals([sig({ stageId: 'tp', deliberatingDue: 6, hotWarmReachableSms: 40 })])
    )
    expect(recs[0].kind).toBe('follow_up_deliberating')
  })
})
