import { describe, it, expect } from 'vitest'
import { applyScopedKnobs } from '../scoped-config'
import type { AutopilotConfig } from '@/lib/autopilot/config'
import type { AllocationDecision } from '../allocation'

const base = { confidence_threshold: 0.65, active_hours_start: 8, active_hours_end: 21, schedule: null } as AutopilotConfig
const dec = (o: Partial<AllocationDecision>): AllocationDecision => ({
  owner: 'ai', reason: 'policy_ai', policyId: 'p', slaSeconds: null, aiRole: null,
  confidenceThreshold: null, activeHoursStart: null, activeHoursEnd: null, ...o,
})

describe('applyScopedKnobs', () => {
  it('overrides confidence + hours when set', () => {
    const c = applyScopedKnobs(base, dec({ confidenceThreshold: 0.9, activeHoursStart: 9, activeHoursEnd: 17 }))
    expect(c.confidence_threshold).toBe(0.9)
    expect(c.active_hours_start).toBe(9)
    expect(c.active_hours_end).toBe(17)
  })
  it('inherits base values when knobs are null', () => {
    const c = applyScopedKnobs(base, dec({}))
    expect(c.confidence_threshold).toBe(0.65)
    expect(c.active_hours_start).toBe(8)
    expect(c.active_hours_end).toBe(21)
  })
  it('does not mutate the base config', () => {
    applyScopedKnobs(base, dec({ confidenceThreshold: 0.9 }))
    expect(base.confidence_threshold).toBe(0.65)
  })
})
