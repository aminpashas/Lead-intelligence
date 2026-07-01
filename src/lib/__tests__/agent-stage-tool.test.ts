import { describe, it, expect } from 'vitest'
import { isAgentStageTransitionAllowed, AGENT_STAGE_TRANSITIONS } from '@/lib/autopilot/agent-tools'
import type { LeadStatus } from '@/types/database'

describe('isAgentStageTransitionAllowed', () => {
  it('permits the whitelisted forward engagement/sales transitions', () => {
    expect(isAgentStageTransitionAllowed('new', 'contacted')).toBe(true)
    expect(isAgentStageTransitionAllowed('new', 'qualified')).toBe(true)
    expect(isAgentStageTransitionAllowed('contacted', 'qualified')).toBe(true)
    expect(isAgentStageTransitionAllowed('consultation_completed', 'treatment_presented')).toBe(true)
    expect(isAgentStageTransitionAllowed('consultation_completed', 'financing')).toBe(true)
    expect(isAgentStageTransitionAllowed('treatment_presented', 'financing')).toBe(true)
  })

  it('never allows a no-op (same stage)', () => {
    for (const s of Object.keys(AGENT_STAGE_TRANSITIONS) as LeadStatus[]) {
      expect(isAgentStageTransitionAllowed(s, s)).toBe(false)
    }
  })

  it('never allows moving backward', () => {
    expect(isAgentStageTransitionAllowed('qualified', 'contacted')).toBe(false)
    expect(isAgentStageTransitionAllowed('qualified', 'new')).toBe(false)
    expect(isAgentStageTransitionAllowed('financing', 'treatment_presented')).toBe(false)
  })

  it('blocks the agent from booking, contracts, clinical, and negative outcomes', () => {
    // booking is create_booking's job
    expect(isAgentStageTransitionAllowed('qualified', 'consultation_scheduled')).toBe(false)
    // contracts are handled by dedicated tooling / signing
    expect(isAgentStageTransitionAllowed('financing', 'contract_sent')).toBe(false)
    expect(isAgentStageTransitionAllowed('financing', 'contract_signed')).toBe(false)
    // clinical / terminal states are never agent-set
    expect(isAgentStageTransitionAllowed('treatment_presented', 'in_treatment')).toBe(false)
    expect(isAgentStageTransitionAllowed('treatment_presented', 'completed')).toBe(false)
    // negative outcomes require a human or the disqualify cron
    expect(isAgentStageTransitionAllowed('contacted', 'lost')).toBe(false)
    expect(isAgentStageTransitionAllowed('qualified', 'disqualified')).toBe(false)
    expect(isAgentStageTransitionAllowed('new', 'no_show')).toBe(false)
  })

  it('has no agent-drivable transition out of terminal/handled stages', () => {
    // stages not present in the whitelist yield no allowed targets at all
    expect(AGENT_STAGE_TRANSITIONS['contract_signed']).toBeUndefined()
    expect(isAgentStageTransitionAllowed('contract_signed', 'completed')).toBe(false)
    expect(isAgentStageTransitionAllowed('lost', 'new')).toBe(false)
  })
})
