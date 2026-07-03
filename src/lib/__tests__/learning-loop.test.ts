import { describe, it, expect } from 'vitest'
import {
  twoProportionZ,
  contrastTechniques,
  contrastEpisodeFeatures,
  type TechniqueOutcomeRow,
  type EpisodeForContrast,
} from '@/lib/ai/learning/contrast'
import { computeRuleSetVersion } from '@/lib/ai/learning/rule-stamp'
import { scrubBody, computeJourneyStats } from '@/lib/ai/learning/episodes'
import type { LearningJourneyStats } from '@/types/database'

function techniqueRows(
  techniqueId: string,
  effective: number,
  other: number
): TechniqueOutcomeRow[] {
  return [
    ...Array.from({ length: effective }, () => ({
      technique_id: techniqueId,
      actual_effectiveness: 'effective',
      agent_type: 'setter',
    })),
    ...Array.from({ length: other }, () => ({
      technique_id: techniqueId,
      actual_effectiveness: 'neutral',
      agent_type: 'setter',
    })),
  ]
}

function statsWith(overrides: Partial<LearningJourneyStats>): LearningJourneyStats {
  return {
    inbound_count: 5,
    outbound_count: 5,
    ai_outbound_count: 3,
    ai_share: 0.6,
    first_response_minutes: 10,
    median_response_minutes: 15,
    days_span: 3,
    techniques_used: [],
    rule_set_versions: [],
    engagement_first: 5,
    engagement_last: 6,
    ...overrides,
  }
}

describe('twoProportionZ', () => {
  it('is ~0 for identical proportions', () => {
    expect(Math.abs(twoProportionZ(0.5, 100, 0.5, 100))).toBeLessThan(1e-9)
  })

  it('is strongly positive when cohort A clearly outperforms', () => {
    expect(twoProportionZ(0.8, 100, 0.4, 100)).toBeGreaterThan(2)
  })
})

describe('contrastTechniques — statistical gates', () => {
  it('emits nothing below the minimum sample size', () => {
    // 10 uses of a perfect technique vs plenty of others — still gated out
    const rows = [...techniqueRows('scarcity', 10, 0), ...techniqueRows('other', 30, 30)]
    const findings = contrastTechniques(rows)
    expect(findings.find((f) => f.key.includes('scarcity'))).toBeUndefined()
  })

  it('emits a prompt-fixable finding for a significant outperformer', () => {
    const rows = [...techniqueRows('social_proof', 45, 5), ...techniqueRows('other', 20, 80)]
    const findings = contrastTechniques(rows)
    const finding = findings.find((f) => f.key === 'technique:social_proof:outperforms')
    expect(finding).toBeDefined()
    expect(finding!.prompt_fixable).toBe(true)
    expect(finding!.stats.z).toBeGreaterThan(2)
  })

  it('ignores too_early rows entirely', () => {
    const rows: TechniqueOutcomeRow[] = Array.from({ length: 200 }, () => ({
      technique_id: 'anything',
      actual_effectiveness: 'too_early',
      agent_type: 'setter',
    }))
    expect(contrastTechniques(rows)).toEqual([])
  })
})

describe('contrastEpisodeFeatures — cohort gates', () => {
  it('emits nothing when a cohort is too small', () => {
    const episodes: EpisodeForContrast[] = [
      ...Array.from({ length: 25 }, () => ({
        outcome: 'booked' as const,
        journey_stats: statsWith({ inbound_count: 10 }),
      })),
      ...Array.from({ length: 5 }, () => ({
        outcome: 'lost' as const,
        journey_stats: statsWith({ inbound_count: 1 }),
      })),
    ]
    expect(contrastEpisodeFeatures(episodes)).toEqual([])
  })

  it('marks response-latency findings as NOT prompt-fixable', () => {
    const episodes: EpisodeForContrast[] = [
      ...Array.from({ length: 25 }, () => ({
        outcome: 'booked' as const,
        journey_stats: statsWith({ first_response_minutes: 5, median_response_minutes: 5 }),
      })),
      ...Array.from({ length: 25 }, () => ({
        outcome: 'lost' as const,
        journey_stats: statsWith({ first_response_minutes: 500, median_response_minutes: 500 }),
      })),
    ]
    const findings = contrastEpisodeFeatures(episodes)
    const latency = findings.find((f) => f.key === 'feature:first_response_minutes')
    expect(latency).toBeDefined()
    expect(latency!.prompt_fixable).toBe(false)
  })
})

describe('rule-set stamping', () => {
  it('is order-independent and stable', () => {
    const v1 = computeRuleSetVersion(['b', 'a', 'c'])
    const v2 = computeRuleSetVersion(['c', 'a', 'b'])
    expect(v1).toBe(v2)
    expect(v1).toHaveLength(12)
  })

  it('changes when the rule set changes', () => {
    expect(computeRuleSetVersion(['a', 'b'])).not.toBe(computeRuleSetVersion(['a', 'b', 'c']))
  })
})

describe('journey scrubbing + stats', () => {
  it('strips emails and long digit runs from bodies', () => {
    const scrubbed = scrubBody('Call me at 415-555-0123 or amin@example.com tomorrow')
    expect(scrubbed).not.toContain('415')
    expect(scrubbed).not.toContain('@example.com')
    expect(scrubbed).toContain('tomorrow')
  })

  it('computes response latency and ai share from a message sequence', () => {
    const t0 = new Date('2026-07-01T10:00:00Z')
    const msg = (minutes: number, direction: string, ai: boolean) => ({
      direction,
      channel: 'sms',
      body: 'hi',
      created_at: new Date(t0.getTime() + minutes * 60000).toISOString(),
      sender_type: ai ? 'ai' : 'staff',
      ai_generated: ai,
      metadata: ai ? { rule_set: { version: 'abc123def456', rule_ids: [] } } : null,
    })
    const stats = computeJourneyStats(
      [msg(0, 'inbound', false), msg(30, 'outbound', true), msg(60, 'inbound', false), msg(70, 'outbound', false)],
      ['social_proof', 'social_proof'],
      [4, 7]
    )
    expect(stats.first_response_minutes).toBe(30)
    expect(stats.inbound_count).toBe(2)
    expect(stats.ai_share).toBe(0.5)
    expect(stats.techniques_used).toEqual(['social_proof'])
    expect(stats.rule_set_versions).toEqual(['abc123def456'])
    expect(stats.engagement_first).toBe(4)
    expect(stats.engagement_last).toBe(7)
  })
})
