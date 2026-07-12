import { describe, it, expect } from 'vitest'
import { assessDraftGate, type DraftGateInput } from '@/lib/ai/draft-gating'
import type { ConversationMessage } from '@/lib/ai/agent-types'

function history(...turns: Array<['user' | 'assistant', string]>): ConversationMessage[] {
  return turns.map(([role, content]) => ({ role, content }))
}

const base: DraftGateInput = {
  patientProfile: null,
  previousAssessment: null,
  history: history(['user', 'What are my financing options?']),
  hasBookedAppointment: false,
}

describe('assessDraftGate — escalation', () => {
  it('blocks when the patient profile shows distress', () => {
    const gate = assessDraftGate({
      ...base,
      patientProfile: {
        emotional_state: 'Rage and humiliation',
        trust_level: 'low',
        next_best_action: 'Have a human apologize and send a working link.',
        ai_summary: 'Repeatedly gaslit by broken systems.',
      },
    })
    expect(gate.block).toBe(true)
    expect(gate.kind).toBe('escalation')
    expect(gate.guidance).toContain('human apologize')
  })

  it('blocks on numeric checkout (high resistance + cold engagement)', () => {
    const gate = assessDraftGate({
      ...base,
      previousAssessment: {
        engagement_temperature: 2,
        resistance_level: 9,
        buying_readiness: 1,
        emotional_state: 'guarded',
        recommended_approach: 'slow down',
        techniques_to_try_next: [],
        techniques_to_avoid: [],
      },
    })
    expect(gate.block).toBe(true)
    expect(gate.kind).toBe('escalation')
  })

  it('does not block a calm, engaged lead', () => {
    const gate = assessDraftGate({
      ...base,
      patientProfile: {
        emotional_state: 'interested',
        trust_level: 'medium',
        next_best_action: null,
        ai_summary: null,
      },
      previousAssessment: {
        engagement_temperature: 7,
        resistance_level: 3,
        buying_readiness: 6,
        emotional_state: 'interested',
        recommended_approach: 'reinforce value',
        techniques_to_try_next: [],
        techniques_to_avoid: [],
      },
    })
    expect(gate.block).toBe(false)
  })
})

describe('assessDraftGate — closed thread', () => {
  it('blocks when we spoke last and the patient signed off', () => {
    const gate = assessDraftGate({
      ...base,
      history: history(
        ['assistant', "Great! You're all set for Thursday at 3 PM."],
        ['user', 'No. Thanks.'],
        ['assistant', 'Perfect! Take care.']
      ),
      hasBookedAppointment: true,
    })
    expect(gate.block).toBe(true)
    expect(gate.kind).toBe('closed')
  })

  it('does NOT treat a terminal-looking phrase with a question as closed', () => {
    const gate = assessDraftGate({
      ...base,
      history: history(
        ['assistant', 'Anything else?'],
        ['user', 'No thanks, but what about financing?']
      ),
    })
    expect(gate.block).toBe(false)
  })

  it('does not block when the patient spoke last (a real reply is pending)', () => {
    const gate = assessDraftGate({
      ...base,
      history: history(['assistant', 'How can I help?'], ['user', 'Tell me about the cost.']),
      hasBookedAppointment: true,
    })
    expect(gate.block).toBe(false)
  })

  it('escalation takes precedence over closed', () => {
    const gate = assessDraftGate({
      patientProfile: { emotional_state: 'furious', trust_level: 'low', next_best_action: null, ai_summary: null },
      previousAssessment: null,
      history: history(['user', 'No thanks.'], ['assistant', 'Take care.']),
      hasBookedAppointment: true,
    })
    expect(gate.block).toBe(true)
    expect(gate.kind).toBe('escalation')
  })
})
