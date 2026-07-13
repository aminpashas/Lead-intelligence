import { describe, it, expect } from 'vitest'
import { formatCampaignPlaybookBlock } from '@/lib/ai/campaign-playbook'

describe('formatCampaignPlaybookBlock', () => {
  it('returns empty string for null/blank playbooks (byte-identical prompt when unset)', () => {
    expect(formatCampaignPlaybookBlock(null)).toBe('')
    expect(formatCampaignPlaybookBlock(undefined)).toBe('')
    expect(formatCampaignPlaybookBlock({})).toBe('')
    // A playbook carrying only the prequal_mode knob has no prompt-facing text.
    expect(formatCampaignPlaybookBlock({ prequal_mode: 'enabled' })).toBe('')
  })

  it('renders goal and tone into the block', () => {
    const block = formatCampaignPlaybookBlock({
      goal: 'Rebook cold implant leads for a consult',
      tone: 'Warm, low-pressure, concise',
    })
    expect(block).toContain('## Campaign Playbook')
    expect(block).toContain('Rebook cold implant leads for a consult')
    expect(block).toContain('Warm, low-pressure, concise')
  })

  it('renders hooks, guardrails and donts as bullet lists', () => {
    const block = formatCampaignPlaybookBlock({
      goal: 'g',
      hooks: ['Free 3D scan', 'Limited monthly slots'],
      guardrails: ['Never quote a final price'],
      donts: ['Do not mention competitors'],
    })
    expect(block).toContain('- Free 3D scan')
    expect(block).toContain('- Limited monthly slots')
    expect(block).toContain('- Never quote a final price')
    expect(block).toContain('- Do not mention competitors')
  })

  it('states that agency rules and safety guidance win over the playbook', () => {
    const block = formatCampaignPlaybookBlock({ goal: 'g' })
    expect(block.toLowerCase()).toContain('always win when they conflict')
  })
})
