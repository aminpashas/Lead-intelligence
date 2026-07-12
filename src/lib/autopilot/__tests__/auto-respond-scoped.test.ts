import { describe, it, expect } from 'vitest'
import { shouldAutoRespond } from '@/lib/autopilot/config'
import { applyScopedKnobs } from '@/lib/automation/scoped-config'

describe('inbound scoped confidence', () => {
  it('escalates below the per-scope threshold even when above the global one', () => {
    const base = { enabled: true, paused: false, confidence_threshold: 0.65,
      mode: 'full', active_hours_start: 0, active_hours_end: 24, schedule: null,
      timezone: 'America/New_York' } as any
    const cfg = applyScopedKnobs(base, {
      confidenceThreshold: 0.9, activeHoursStart: null, activeHoursEnd: null,
    } as any)
    const r = shouldAutoRespond(cfg, { confidence: 0.8, agentType: 'setter', isFirstMessage: false, currentHour: 12 })
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('low_confidence')
  })
})
