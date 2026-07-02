import { describe, it, expect } from 'vitest'
import { formatRulesBlock, deriveRuleFields } from '@/lib/ai/agency-rules'
import { findScenario } from '@/lib/ai/roleplay-engine'

describe('formatRulesBlock', () => {
  it('returns empty string when there are no rules', () => {
    expect(formatRulesBlock([])).toBe('')
  })

  it('renders a heading + each rule as ### title [category]\\ncontent', () => {
    const block = formatRulesBlock([
      { title: 'Competitor pricing', category: 'objection', content: 'Lead with value, never match price.' },
    ])
    expect(block.startsWith('## Agency Rules')).toBe(true)
    expect(block).toContain('### Competitor pricing [objection]')
    expect(block).toContain('Lead with value, never match price.')
  })
})

describe('deriveRuleFields', () => {
  it('derives a truncated title, general category, priority 100, full content', () => {
    const r = deriveRuleFields('When a patient mentions a cheaper competitor, acknowledge value and never match price.')
    expect(r.title.length).toBeLessThanOrEqual(60)
    expect(r.title.startsWith('When a patient mentions a cheaper')).toBe(true)
    expect(r.category).toBe('general')
    expect(r.priority).toBe(100)
    expect(r.content).toContain('never match price')
  })

  it('trims whitespace', () => {
    expect(deriveRuleFields('  be warm  ').content).toBe('be warm')
  })
})

describe('findScenario', () => {
  it('fuzzy-matches a built-in scenario by words in its name', () => {
    expect(findScenario('cost objection')?.id).toBe('cost-objection')
    expect(findScenario('anxious')?.id).toBe('anxious-patient')
  })
  it('returns the default new-patient scenario for empty/unknown input', () => {
    expect(findScenario('')?.id).toBe('new-patient-sms')
    expect(findScenario('nonsense zzz')?.id).toBe('new-patient-sms')
  })
})
