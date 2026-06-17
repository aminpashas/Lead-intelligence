import { describe, it, expect } from 'vitest'
import { detectCompetitorMentions } from '@/lib/competitive/detect'
import { selectNegotiationLevers } from '@/lib/ai/negotiation'

const COMPETITORS = [
  { id: 'c1', name: 'ClearChoice', aliases: ['clear choice'] },
  { id: 'c2', name: 'Aspen Dental', aliases: [] },
  { id: 'c3', name: 'Nuvia', aliases: ['nuvia smiles'] },
]

describe('detectCompetitorMentions', () => {
  it('matches name case-insensitively on word boundaries', () => {
    const m = detectCompetitorMentions('I also got a quote from ClearChoice last week', COMPETITORS)
    expect(m).toHaveLength(1)
    expect(m[0].competitorId).toBe('c1')
  })

  it('matches aliases', () => {
    const m = detectCompetitorMentions('nuvia smiles offered me a deal', COMPETITORS)
    expect(m[0].competitorId).toBe('c3')
  })

  it('detects multiple distinct competitors, once each', () => {
    const m = detectCompetitorMentions('ClearChoice vs Aspen Dental vs ClearChoice again', COMPETITORS)
    expect(m.map((x) => x.competitorId).sort()).toEqual(['c1', 'c2'])
  })

  it('does not match substrings (word boundary)', () => {
    expect(detectCompetitorMentions('aspendental-ish unrelated word aspendentalish', COMPETITORS)).toHaveLength(0)
  })

  it('empty text or no competitors → no matches', () => {
    expect(detectCompetitorMentions('', COMPETITORS)).toEqual([])
    expect(detectCompetitorMentions('ClearChoice', [])).toEqual([])
  })
})

describe('selectNegotiationLevers', () => {
  const policy = {
    enabledLevers: ['extend_financing_term', 'phased_treatment', 'scheduling_incentive'] as const,
  }

  it('low sensitivity → no concessions', () => {
    expect(selectNegotiationLevers({ enabledLevers: [...policy.enabledLevers] }, 'low')).toEqual([])
  })

  it('high sensitivity → all enabled levers (never disabled ones)', () => {
    const r = selectNegotiationLevers({ enabledLevers: [...policy.enabledLevers] }, 'high')
    expect(r).toContain('extend_financing_term')
    expect(r).toContain('scheduling_incentive')
    expect(r).not.toContain('in_house_plan') // not enabled by this org
  })

  it('medium sensitivity → only the gentler enabled levers', () => {
    const r = selectNegotiationLevers({ enabledLevers: [...policy.enabledLevers] }, 'medium')
    expect(r).toContain('scheduling_incentive')
    expect(r).toContain('phased_treatment')
    expect(r).not.toContain('extend_financing_term')
  })

  it('never offers a lever the org disabled', () => {
    const r = selectNegotiationLevers({ enabledLevers: ['scheduling_incentive'] }, 'high')
    expect(r).toEqual(['scheduling_incentive'])
  })
})
