import { describe, it, expect } from 'vitest'
import { automationPolicyInput } from '../automation-policy'

describe('automationPolicyInput', () => {
  it('accepts a stage rule', () => {
    const r = automationPolicyInput.safeParse({ scope: 'stage', stage_id: '00000000-0000-4000-8000-000000000001', kinds: ['inbound_reply'], owner: 'ai' })
    expect(r.success).toBe(true)
  })
  it('rejects a campaign rule with no target', () => {
    const r = automationPolicyInput.safeParse({ scope: 'campaign', kinds: ['inbound_reply'], owner: 'ai' })
    expect(r.success).toBe(false)
  })
  it('rejects inverted hours', () => {
    const r = automationPolicyInput.safeParse({ scope: 'stage', stage_id: '00000000-0000-4000-8000-000000000001', kinds: ['inbound_reply'], owner: 'ai', active_hours_start: 18, active_hours_end: 9 })
    expect(r.success).toBe(false)
  })
})
