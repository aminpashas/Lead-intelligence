import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock all external dependencies with factory functions
vi.mock('@/lib/ai/agent-handoff', () => ({
  routeToAgent: vi.fn(),
  getHandoffHistory: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/lib/ai/patient-psychology', () => ({
  getPatientProfile: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/ai/prompt-guard', () => ({
  detectPromptInjection: vi.fn().mockReturnValue({ isClean: true, detections: [], sanitizedText: '' }),
  wrapUserContent: vi.fn((c: string) => c),
}))
vi.mock('@/lib/ai/hipaa', () => ({
  logHIPAAEvent: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/autopilot/config', () => ({
  getAutopilotConfig: vi.fn().mockResolvedValue({
    enabled: true,
    paused: false,
    confidence_threshold: 0.75,
    mode: 'full',
    response_delay_min: 30,
    response_delay_max: 180,
    max_messages_per_hour: 10,
    active_hours_start: 8,
    active_hours_end: 21,
    stop_words: ['stop', 'unsubscribe', 'opt out'],
    speed_to_lead: true,
    schedule: null,
    timezone: 'America/New_York',
    outreach_suppressed: false,
  }),
  detectStopWord: vi.fn().mockReturnValue({ detected: false, word: null }),
}))
vi.mock('@/lib/autopilot/escalation', () => ({
  createEscalation: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { processVoiceTranscript, isVoiceCallEnding, isUserEndingCall, VOICE_CHANNEL_INSTRUCTIONS, type VoiceAgentContext } from '@/lib/voice/voice-agent'
import {
  buildCurrentDateBlock,
  buildUpcomingDatesList,
  buildDateDynamicVariables,
} from '@/lib/ai/datetime-context'
import { routeToAgent } from '@/lib/ai/agent-handoff'
import { detectStopWord } from '@/lib/autopilot/config'
import { getAutopilotConfig } from '@/lib/autopilot/config'
import { detectPromptInjection } from '@/lib/ai/prompt-guard'
import { createEscalation } from '@/lib/autopilot/escalation'
import type { RetellLLMRequest } from '@/lib/voice/retell-client'

// ── Helpers ─────────────────────────────────────────────────────

function makeSupabase(orgData: Record<string, unknown> = {}) {
  const singleFn = vi.fn().mockResolvedValue({
    data: { name: 'Bright Smiles Dental', voice_greeting: null, phone: '+15551234567', voice_two_party_consent_states: [], ...orgData },
    error: null,
  })
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: singleFn,
    update: vi.fn().mockReturnThis(),
  }
  return {
    from: vi.fn().mockReturnValue(chain),
    _chain: chain,
    _singleFn: singleFn,
  }
}

function makeVoiceContext(overrides: Partial<VoiceAgentContext> = {}): VoiceAgentContext {
  return {
    organization_id: 'org-1',
    lead_id: 'lead-1',
    lead: { first_name: 'Sarah', last_name: 'Johnson', status: 'new', state: 'TX' },
    conversation_id: 'conv-1',
    conversation: {},
    call_id: 'call-1',
    direction: 'inbound',
    ...overrides,
  }
}

function makeRetellRequest(overrides: Partial<RetellLLMRequest> = {}): RetellLLMRequest {
  return {
    interaction_type: 'response_required',
    call: { call_id: 'call-1', from_number: '+1', to_number: '+2', direction: 'inbound', metadata: {} },
    transcript: [
      { role: 'agent', content: 'Hi! How can I help?' },
      { role: 'user', content: 'I want to learn about dental implants' },
    ],
    ...overrides,
  }
}

/**
 * Reset all mock implementations to their defaults before each test.
 * vi.clearAllMocks() clears call history AND return values, so we must
 * re-establish the default return values for mocks used in the normal flow.
 */
beforeEach(() => {
  vi.clearAllMocks()

  // Re-establish default return values that were cleared
  vi.mocked(detectStopWord).mockReturnValue({ detected: false, word: null })
  vi.mocked(getAutopilotConfig).mockResolvedValue({
    enabled: true,
    paused: false,
    confidence_threshold: 0.75,
    mode: 'full',
    response_delay_min: 30,
    response_delay_max: 180,
    max_messages_per_hour: 10,
    active_hours_start: 8,
    active_hours_end: 21,
    stop_words: ['stop', 'unsubscribe', 'opt out'],
    speed_to_lead: true,
    schedule: null,
    timezone: 'America/New_York',
    outreach_suppressed: false,
  })
  vi.mocked(detectPromptInjection).mockReturnValue({ isClean: true, detections: [], sanitizedText: '' })
})

// ═══════════════════════════════════════════════════════════════
// Greeting Generation
// ═══════════════════════════════════════════════════════════════

describe('processVoiceTranscript — greeting (call_details)', () => {
  it('generates inbound greeting with patient name', async () => {
    const supabase = makeSupabase()
    const request = makeRetellRequest({ interaction_type: 'call_details', transcript: [] })
    const context = makeVoiceContext({ direction: 'inbound' })

    const result = await processVoiceTranscript(supabase as any, request, context)

    expect(result.response).toContain('Bright Smiles Dental')
    expect(result.response).toContain('Sarah')
    expect(result.end_call).toBe(false)
    expect(result.agent).toBe('setter')
    expect(result.action_taken).toBe('greeted')
  })

  it('generates outbound greeting with patient name', async () => {
    const supabase = makeSupabase()
    const request = makeRetellRequest({ interaction_type: 'call_details', transcript: [] })
    const context = makeVoiceContext({ direction: 'outbound' })

    const result = await processVoiceTranscript(supabase as any, request, context)

    expect(result.response).toContain('Sarah')
    expect(result.response).toContain('Bright Smiles Dental')
    expect(result.action_taken).toBe('greeted')
  })

  it('generates inbound greeting without name', async () => {
    const supabase = makeSupabase()
    const request = makeRetellRequest({ interaction_type: 'call_details', transcript: [] })
    const context = makeVoiceContext({ direction: 'inbound', lead: { status: 'new' } })

    const result = await processVoiceTranscript(supabase as any, request, context)

    expect(result.response).toContain('Bright Smiles Dental')
    expect(result.response).not.toContain('undefined')
    expect(result.action_taken).toBe('greeted')
  })

  it('uses custom voice_greeting when configured', async () => {
    const supabase = makeSupabase({
      voice_greeting: 'Welcome to {practice_name}, {first_name}!',
    })
    const request = makeRetellRequest({ interaction_type: 'call_details', transcript: [] })
    const context = makeVoiceContext({ direction: 'outbound' })

    const result = await processVoiceTranscript(supabase as any, request, context)

    expect(result.response).toBe('Welcome to Bright Smiles Dental, Sarah!')
  })
})

// ═══════════════════════════════════════════════════════════════
// Update-only interaction
// ═══════════════════════════════════════════════════════════════

describe('processVoiceTranscript — update_only', () => {
  it('returns empty response for update_only', async () => {
    const supabase = makeSupabase()
    const request = makeRetellRequest({ interaction_type: 'update_only' })

    const result = await processVoiceTranscript(supabase as any, request, makeVoiceContext())

    expect(result.response).toBe('')
    expect(result.end_call).toBe(false)
    expect(result.action_taken).toBe('listened')
  })
})

// ═══════════════════════════════════════════════════════════════
// Silence / Empty message handling
// ═══════════════════════════════════════════════════════════════

describe('processVoiceTranscript — empty message', () => {
  it('sends nudge for reminder_required with no user content', async () => {
    const supabase = makeSupabase()
    const request = makeRetellRequest({
      interaction_type: 'reminder_required',
      transcript: [{ role: 'agent', content: 'Hello?' }],
    })

    const result = await processVoiceTranscript(supabase as any, request, makeVoiceContext())

    expect(result.response).toContain('still there')
    expect(result.action_taken).toBe('reminded')
  })

  it('returns empty for response_required with no user content', async () => {
    const supabase = makeSupabase()
    const request = makeRetellRequest({
      interaction_type: 'response_required',
      transcript: [{ role: 'agent', content: 'Hi there!' }],
    })

    const result = await processVoiceTranscript(supabase as any, request, makeVoiceContext())

    expect(result.response).toBe('')
    expect(result.action_taken).toBe('waited')
  })
})

// ═══════════════════════════════════════════════════════════════
// Opt-out Detection
// ═══════════════════════════════════════════════════════════════

describe('processVoiceTranscript — opt-out', () => {
  it('ends call and marks opt-out when stop word detected', async () => {
    vi.mocked(detectStopWord).mockReturnValue({ detected: true, word: 'do not call me again' })

    const supabase = makeSupabase()
    const request = makeRetellRequest({
      transcript: [{ role: 'user', content: 'Do not call me again' }],
    })

    const result = await processVoiceTranscript(supabase as any, request, makeVoiceContext())

    expect(result.end_call).toBe(true)
    expect(result.action_taken).toBe('opted_out')
    expect(result.response).toContain('removed your number')
    expect(createEscalation).toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════
// Normal response flow
// ═══════════════════════════════════════════════════════════════

describe('processVoiceTranscript — normal flow', () => {
  it('routes to agent and returns adapted voice response', async () => {
    vi.mocked(routeToAgent).mockResolvedValue({
      message: 'That sounds great! The All-on-4 costs about twenty five thousand dollars.',
      confidence: 0.9,
      agent: 'setter',
      action_taken: 'provided_education',
      should_handoff: false,
    })

    const supabase = makeSupabase()
    const request = makeRetellRequest()

    const result = await processVoiceTranscript(supabase as any, request, makeVoiceContext())

    expect(result.agent).toBe('setter')
    expect(result.confidence).toBe(0.9)
    expect(result.end_call).toBe(false)
  })

  it('transfers to human when agent escalates', async () => {
    vi.mocked(routeToAgent).mockResolvedValue({
      message: 'Let me connect you with someone.',
      confidence: 0.5,
      agent: 'setter',
      action_taken: 'escalated_to_human',
      should_handoff: false,
    })

    const supabase = makeSupabase()
    const request = makeRetellRequest()

    const result = await processVoiceTranscript(supabase as any, request, makeVoiceContext())

    expect(result.transfer_number).toBe('+15551234567')
    expect(result.action_taken).toBe('escalated_to_human')
  })

  it('handles agent routing failure gracefully', async () => {
    vi.mocked(routeToAgent).mockRejectedValue(new Error('AI service down'))

    const supabase = makeSupabase()
    const request = makeRetellRequest()

    const result = await processVoiceTranscript(supabase as any, request, makeVoiceContext())

    expect(result.response).toContain('trouble')
    expect(result.transfer_number).toBe('+15551234567')
    expect(result.confidence).toBe(0)
    expect(result.action_taken).toBe('escalated_to_human')
    expect(createEscalation).toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════
// Voice Response Adaptation (via adaptResponseForVoice)
// ═══════════════════════════════════════════════════════════════

describe('Voice response adaptation (through processVoiceTranscript)', () => {
  it('removes markdown bold and italic', async () => {
    vi.mocked(routeToAgent).mockResolvedValue({
      message: '**Bold text** and *italic text*',
      confidence: 0.9, agent: 'setter', action_taken: 'responded', should_handoff: false,
    })
    const result = await processVoiceTranscript(makeSupabase() as any, makeRetellRequest(), makeVoiceContext())
    expect(result.response).not.toContain('**')
    expect(result.response).not.toContain('*')
    expect(result.response).toContain('Bold text')
    expect(result.response).toContain('italic text')
  })

  it('removes markdown headers', async () => {
    vi.mocked(routeToAgent).mockResolvedValue({
      message: '## Important Info\nSome details here',
      confidence: 0.9, agent: 'setter', action_taken: 'responded', should_handoff: false,
    })
    const result = await processVoiceTranscript(makeSupabase() as any, makeRetellRequest(), makeVoiceContext())
    expect(result.response).not.toContain('##')
    expect(result.response).toContain('Important Info')
  })

  it('converts dollar amounts to spoken form', async () => {
    vi.mocked(routeToAgent).mockResolvedValue({
      message: 'The procedure costs $25,000 and the deposit is $500.',
      confidence: 0.9, agent: 'setter', action_taken: 'responded', should_handoff: false,
    })
    const result = await processVoiceTranscript(makeSupabase() as any, makeRetellRequest(), makeVoiceContext())
    expect(result.response).toContain('25 thousand')
    expect(result.response).toContain('500 dollars')
    expect(result.response).not.toContain('$25,000')
  })

  it('converts abbreviations to spoken form', async () => {
    vi.mocked(routeToAgent).mockResolvedValue({
      message: 'Dr. Smith says e.g. implants vs. dentures etc.',
      confidence: 0.9, agent: 'setter', action_taken: 'responded', should_handoff: false,
    })
    const result = await processVoiceTranscript(makeSupabase() as any, makeRetellRequest(), makeVoiceContext())
    expect(result.response).toContain('Doctor')
    expect(result.response).toContain('for example')
    expect(result.response).toContain('versus')
    expect(result.response).toContain('and so on')
  })

  it('replaces URLs with spoken placeholder', async () => {
    vi.mocked(routeToAgent).mockResolvedValue({
      message: 'Check out https://brightsmiles.com/pricing for details.',
      confidence: 0.9, agent: 'setter', action_taken: 'responded', should_handoff: false,
    })
    const result = await processVoiceTranscript(makeSupabase() as any, makeRetellRequest(), makeVoiceContext())
    expect(result.response).toContain('the link we can send you')
    expect(result.response).not.toContain('https://')
  })
})

// ═══════════════════════════════════════════════════════════════
// VOICE_CHANNEL_INSTRUCTIONS export
// ═══════════════════════════════════════════════════════════════

describe('VOICE_CHANNEL_INSTRUCTIONS', () => {
  it('is exported as a non-empty string', () => {
    expect(typeof VOICE_CHANNEL_INSTRUCTIONS).toBe('string')
    expect(VOICE_CHANNEL_INSTRUCTIONS.length).toBeGreaterThan(100)
  })

  it('mentions key voice rules', () => {
    expect(VOICE_CHANNEL_INSTRUCTIONS).toContain('BREVITY')
    expect(VOICE_CHANNEL_INSTRUCTIONS).toContain('CONVERSATIONAL TONE')
    expect(VOICE_CHANNEL_INSTRUCTIONS).toContain('WARM TRANSFER')
  })
})

// ═══════════════════════════════════════════════════════════════
// isVoiceCallEnding — agent-side hang-up detection
// ═══════════════════════════════════════════════════════════════

describe('isVoiceCallEnding', () => {
  it('ends on a clear farewell with no trailing question', () => {
    expect(isVoiceCallEnding('Thanks so much, John — take care!', 'confirmed_appointment')).toBe(true)
    expect(isVoiceCallEnding("Perfect, we'll see you Tuesday. Have a great day!", 'responded')).toBe(true)
    expect(isVoiceCallEnding('Goodbye!', 'responded')).toBe(true)
  })

  it('ends when the agent gracefully disengages', () => {
    expect(isVoiceCallEnding('No problem at all, reach out anytime.', 'disengaged_gracefully')).toBe(true)
  })

  it('does NOT end when the message still asks a question', () => {
    expect(isVoiceCallEnding('Thanks for calling — how can I help you today?', 'greeted')).toBe(false)
    expect(isVoiceCallEnding('Take care of that tooth! Does Tuesday work for you?', 'attempted_scheduling')).toBe(false)
  })

  it('does NOT end mid-conversation with no farewell', () => {
    expect(isVoiceCallEnding('The All-on-4 uses four implants for a full arch.', 'provided_education')).toBe(false)
    expect(isVoiceCallEnding('', 'responded')).toBe(false)
  })

  it('never ends when escalating to a human (transfer, not hang-up)', () => {
    expect(isVoiceCallEnding('Let me connect you with someone. Take care.', 'escalated_to_human')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════
// isUserEndingCall — caller-side hang-up (fixes the "hi after bye" loop)
// ═══════════════════════════════════════════════════════════════

describe('isUserEndingCall', () => {
  it('ends when the caller clearly signs off', () => {
    expect(isUserEndingCall('ok thanks, bye')).toBe(true)
    expect(isUserEndingCall('Goodbye')).toBe(true)
    expect(isUserEndingCall("that's all I needed, thank you so much")).toBe(true)
    expect(isUserEndingCall('gotta go')).toBe(true)
    expect(isUserEndingCall("no thanks, I'm all set")).toBe(true)
  })

  it('does NOT end when the caller is still engaged', () => {
    expect(isUserEndingCall('what times do you have on Tuesday?')).toBe(false)
    expect(isUserEndingCall('maybe next week could work')).toBe(false) // "maybe" must not trip "bye"
    expect(isUserEndingCall('thanks for explaining, that makes sense — can you tell me about the cost?')).toBe(false)
    expect(isUserEndingCall('')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════
// buildCurrentDateBlock — date awareness
// ═══════════════════════════════════════════════════════════════

describe('buildCurrentDateBlock', () => {
  it('states the current date and time as ground truth and includes the day of month', () => {
    const block = buildCurrentDateBlock('America/New_York')
    expect(block).toContain('CURRENT DATE & TIME (GROUND TRUTH)')
    expect(block).toContain('America/New_York')
    expect(block).toMatch(/day \d+ of the month/)
    // Time-of-day is now part of the ground truth (e.g. "3:47 PM EDT").
    expect(block).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/)
  })

  it('falls back gracefully on an invalid timezone', () => {
    expect(() => buildCurrentDateBlock('Not/AZone')).not.toThrow()
    expect(() => buildCurrentDateBlock(null)).not.toThrow()
    expect(() => buildCurrentDateBlock(undefined)).not.toThrow()
  })

  it('embeds a dated calendar and forbids computing dates by hand', () => {
    const block = buildCurrentDateBlock('America/New_York')
    // Today and tomorrow are explicitly labeled so the model never guesses.
    expect(block).toMatch(/\(today\)/)
    expect(block).toMatch(/\(tomorrow\)/)
    // Instruction that fixes "next Tuesday but doesn't know when".
    expect(block).toContain('never a bare')
  })
})

describe('buildUpcomingDatesList', () => {
  it('produces one dated line per day, marking today and tomorrow', () => {
    const list = buildUpcomingDatesList('America/New_York', 14)
    const lines = list.split('\n')
    expect(lines).toHaveLength(14)
    expect(lines[0]).toContain('(today)')
    expect(lines[1]).toContain('(tomorrow)')
    // Every line names a weekday and a numeric day.
    for (const line of lines) {
      expect(line).toMatch(/^- \w+day, \w+ \d+/)
    }
  })

  it('respects a custom horizon and never throws on a bad timezone', () => {
    expect(buildUpcomingDatesList('America/New_York', 3).split('\n')).toHaveLength(3)
    expect(() => buildUpcomingDatesList('Not/AZone')).not.toThrow()
  })
})

describe('buildDateDynamicVariables (Retell voice)', () => {
  it('returns a current_datetime string and an upcoming_dates calendar', () => {
    const vars = buildDateDynamicVariables('America/Los_Angeles')
    expect(typeof vars.current_datetime).toBe('string')
    expect(vars.current_datetime).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/)
    expect(vars.upcoming_dates).toContain('(today)')
  })
})
