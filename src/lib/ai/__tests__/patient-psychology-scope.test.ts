import { describe, it, expect } from 'vitest'
import { formatPatientPsychologyForPrompt } from '../agent-types'
import type { PatientProfile } from '@/types/database'

/**
 * Guard: the SETTER (concern → history → booking) must never inherit
 * sales/financing psychology. Those fields belong to the Closer / qualification
 * workflow. This pins the behavior that a financing-laden profile — the exact
 * shape the hourly psychology sweep produced for the Amin test lead after a
 * financing-heavy conversation — cannot bleed `$0 down`, a "send the financing
 * link" next-action, or the sales narrative into a Setter reply.
 */
const financingLadenProfile: PatientProfile = {
  id: 'p1',
  organization_id: 'org1',
  lead_id: 'lead1',
  personality_type: 'amiable',
  communication_style: 'direct',
  decision_making_style: 'impulsive',
  trust_level: 'very_low',
  emotional_state: 'Rage and humiliation after broken links and fake confirmations',
  anxiety_level: 8,
  confidence_level: 1,
  motivation_level: 4,
  pain_points: [{ point: 'Financial hardship — has no money for implants', severity: 9, mentioned_count: 3 }],
  desires: [{ desire: 'A working financing application with $0 down', importance: 10, mentioned_count: 2 }],
  objections: [{ objection: 'Cannot afford implants', severity: 9, addressed: true, approach_used: '$0 down financing' }],
  price_sensitivity: 10,
  urgency_perception: 3,
  negotiation_style: 'accommodating',
  influence_factors: ['practical'],
  rapport_score: 1,
  personal_details: { teeth_status: 'edentulous' },
  preferred_contact_time: null,
  preferred_channel: 'sms',
  humor_receptivity: 'avoid',
  total_conversations_analyzed: 3,
  key_moments: [],
  ai_summary: 'Fully edentulous, financially vulnerable — recovery requires a human and a working financing link with $0 down.',
  next_best_action: 'A human must reach out and include a direct, confirmed-working financing application link.',
  recommended_tone: 'Frame everything through low monthly payments.',
  topics_to_avoid: ['scripted messaging'],
  topics_to_emphasize: ['$0 down and low monthly payment financing', 'same-day smile'],
  last_analyzed_at: '2026-07-06T02:13:51Z',
  analysis_version: 3,
  created_at: '2026-07-02T20:48:51Z',
  updated_at: '2026-07-06T02:13:51Z',
}

const FINANCING = /financ|\$0 down|monthly payment|afford|next action|human must reach out/i

describe('formatPatientPsychologyForPrompt — setter scope guard', () => {
  it('setter scope strips all financing/sales content', () => {
    const out = formatPatientPsychologyForPrompt(financingLadenProfile, { scope: 'setter' })
    expect(out).not.toMatch(FINANCING)
    expect(out).not.toContain('Recommended next action')
    expect(out).not.toContain('Analyst read of this patient')
    expect(out).not.toContain('Topics to emphasize')
    expect(out).not.toContain('Key pain points')
    expect(out).not.toContain('Key desires')
  })

  it('setter scope still preserves interpersonal + distress tone handling', () => {
    const out = formatPatientPsychologyForPrompt(financingLadenProfile, { scope: 'setter' })
    expect(out).toContain('Personality type: amiable')
    expect(out).toContain('Trust level: very_low')
    // The distress tone-override must survive so the Setter still handles an
    // upset patient gently — it just must not pitch money.
    expect(out).toContain('TONE OVERRIDE')
  })

  it('full scope (default, used by Closer/scoring) is unchanged and DOES carry sales context', () => {
    const out = formatPatientPsychologyForPrompt(financingLadenProfile)
    expect(out).toContain('Recommended next action')
    expect(out).toContain('Topics to emphasize')
    expect(out).toContain('Analyst read of this patient')
    expect(out).toMatch(FINANCING)
  })

  it('null profile is unchanged for both scopes', () => {
    const base = 'No patient psychology profile available yet'
    expect(formatPatientPsychologyForPrompt(null)).toContain(base)
    expect(formatPatientPsychologyForPrompt(null, { scope: 'setter' })).toContain(base)
  })
})
