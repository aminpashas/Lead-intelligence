import { describe, it, expect, vi, beforeEach } from 'vitest'

// Create persistent mock for Anthropic's messages.create
const mockCreate = vi.fn()

// Mock Anthropic as a proper class that survives vi.clearAllMocks
vi.mock('@anthropic-ai/sdk', () => {
  // Use a real class to survive vi.clearAllMocks (which clears vi.fn implementations)
  class MockAnthropic {
    messages = { create: mockCreate }
    constructor(_opts?: unknown) {}
  }
  return { default: MockAnthropic, __esModule: true }
})

vi.mock('@/lib/ai/hipaa', () => ({
  buildSafeLeadContext: vi.fn((lead: Record<string, unknown>) => {
    const parts: string[] = []
    if (lead.first_name) parts.push(`Name: ${lead.first_name}`)
    if (lead.dental_condition) parts.push(`Dental Condition: ${lead.dental_condition}`)
    if (lead.status) parts.push(`Status: ${lead.status}`)
    if (lead.source_type) parts.push(`Source: ${lead.source_type}`)
    return parts.join('\n') || 'Minimal lead context'
  }),
  // Mirrors the real mapping: message rows → {role, content} turns. A pass-through
  // stub here hid the fact that callers read .role/.content, not .direction/.body.
  buildSafeConversationHistory: vi.fn((msgs: Array<{ direction: string; body: string }>) =>
    msgs.map((m) => ({ role: m.direction === 'inbound' ? 'user' : 'assistant', content: m.body }))
  ),
  checkResponseCompliance: vi.fn().mockReturnValue([]),
  logHIPAAEvent: vi.fn().mockResolvedValue(undefined),
  scrubPHI: vi.fn((text: string) => text),
}))

vi.mock('@/lib/enrichment', () => ({
  getEnrichmentSummary: vi.fn().mockResolvedValue(null),
}))

// Service-role client used by rescoreAndPersistLead for the persist. The leads
// UPDATE resolves through mockMaybeSingle so tests can simulate a landed write
// ({ data: { id } }) vs. an RLS/cross-org 0-row no-op ({ data: null }).
const mockMaybeSingle = vi.fn()
const mockInsert = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (table: string) =>
      table === 'leads'
        ? {
            update: () => ({
              eq: () => ({
                eq: () => ({
                  select: () => ({ maybeSingle: mockMaybeSingle }),
                }),
              }),
            }),
          }
        : { insert: mockInsert },
  }),
}))

import { scoreLead, generateLeadEngagement, rescoreAndPersistLead, weightedTotal, applyIntentFloor, type ScoreResult } from '@/lib/ai/scoring'
import { getEnrichmentSummary } from '@/lib/enrichment'
import { logHIPAAEvent, checkResponseCompliance } from '@/lib/ai/hipaa'

// ── Helper to set Anthropic response ────────────────────────────

function setAnthropicResponse(responseText: string) {
  mockCreate.mockResolvedValue({
    content: [{ type: 'text', text: responseText }],
  })
}

function makeScoringResponse(overrides: Partial<{
  dimensions: Array<{ name: string; score: number; weight: number; reasoning: string }>
  summary: string
  recommended_action: string
  confidence: number
}> = {}) {
  const defaults = {
    dimensions: [
      { name: 'dental_condition', score: 85, weight: 0.22, reasoning: 'Missing all teeth upper arch' },
      { name: 'financial_readiness', score: 70, weight: 0.18, reasoning: 'Open to financing' },
      { name: 'urgency', score: 90, weight: 0.18, reasoning: 'Wants treatment ASAP, in pain' },
      { name: 'engagement', score: 75, weight: 0.12, reasoning: 'Responded quickly' },
      { name: 'demographics', score: 60, weight: 0.08, reasoning: 'Age 55, local area' },
      { name: 'source_quality', score: 80, weight: 0.07, reasoning: 'Google Ads high-intent' },
      { name: 'identity_confidence', score: 70, weight: 0.08, reasoning: 'Valid email + phone' },
      { name: 'behavioral_intent', score: 65, weight: 0.07, reasoning: 'Viewed pricing page' },
    ],
    summary: 'Hot lead with urgent dental needs, ready for consultation.',
    recommended_action: 'Schedule consultation within 24 hours.',
    confidence: 0.9,
    ...overrides,
  }
  return JSON.stringify(defaults)
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  // Re-establish default mock values after clearAllMocks
  vi.mocked(checkResponseCompliance).mockReturnValue([])
  vi.mocked(getEnrichmentSummary).mockResolvedValue(null)
  vi.mocked(logHIPAAEvent).mockResolvedValue(undefined)
})

// ═══════════════════════════════════════════════════════════════
// scoreLead
// ═══════════════════════════════════════════════════════════════

describe('scoreLead', () => {
  it('returns a valid ScoreResult with weighted total score', async () => {
    setAnthropicResponse(makeScoringResponse())

    const result = await scoreLead({
      first_name: 'Sarah',
      dental_condition: 'missing_all_both',
      status: 'new',
      source_type: 'google_ads',
    })

    expect(result.total_score).toBeGreaterThan(0)
    expect(result.total_score).toBeLessThanOrEqual(100)
    expect(result.dimensions).toHaveLength(8)
    expect(result.summary).toBeTruthy()
    expect(result.recommended_action).toBeTruthy()
    expect(result.confidence).toBe(0.9)
  })

  it('calculates correct weighted total from dimensions', async () => {
    const dims = [
      { name: 'dental_condition', score: 100, weight: 0.22, reasoning: '' },
      { name: 'financial_readiness', score: 100, weight: 0.18, reasoning: '' },
      { name: 'urgency', score: 100, weight: 0.18, reasoning: '' },
      { name: 'engagement', score: 100, weight: 0.12, reasoning: '' },
      { name: 'demographics', score: 100, weight: 0.08, reasoning: '' },
      { name: 'source_quality', score: 100, weight: 0.07, reasoning: '' },
      { name: 'identity_confidence', score: 100, weight: 0.08, reasoning: '' },
      { name: 'behavioral_intent', score: 100, weight: 0.07, reasoning: '' },
    ]
    setAnthropicResponse(makeScoringResponse({ dimensions: dims }))

    const result = await scoreLead({ first_name: 'Test' })

    // All 100s with weights summing to 1.0 → total = 100
    expect(result.total_score).toBe(100)
  })

  it('classifies as "hot" when total >= 75', async () => {
    setAnthropicResponse(makeScoringResponse()) // default gives ~78
    const result = await scoreLead({ first_name: 'Hot' })
    expect(result.qualification).toBe('hot')
  })

  it('classifies as "warm" when total is 50-74', async () => {
    const dims = [
      { name: 'dental_condition', score: 60, weight: 0.22, reasoning: '' },
      { name: 'financial_readiness', score: 50, weight: 0.18, reasoning: '' },
      { name: 'urgency', score: 55, weight: 0.18, reasoning: '' },
      { name: 'engagement', score: 50, weight: 0.12, reasoning: '' },
      { name: 'demographics', score: 50, weight: 0.08, reasoning: '' },
      { name: 'source_quality', score: 50, weight: 0.07, reasoning: '' },
      { name: 'identity_confidence', score: 50, weight: 0.08, reasoning: '' },
      { name: 'behavioral_intent', score: 50, weight: 0.07, reasoning: '' },
    ]
    setAnthropicResponse(makeScoringResponse({ dimensions: dims }))
    const result = await scoreLead({ first_name: 'Warm' })
    expect(result.qualification).toBe('warm')
  })

  it('classifies as "cold" when total is 25-49', async () => {
    const dims = [
      { name: 'dental_condition', score: 30, weight: 0.22, reasoning: '' },
      { name: 'financial_readiness', score: 30, weight: 0.18, reasoning: '' },
      { name: 'urgency', score: 30, weight: 0.18, reasoning: '' },
      { name: 'engagement', score: 30, weight: 0.12, reasoning: '' },
      { name: 'demographics', score: 30, weight: 0.08, reasoning: '' },
      { name: 'source_quality', score: 30, weight: 0.07, reasoning: '' },
      { name: 'identity_confidence', score: 30, weight: 0.08, reasoning: '' },
      { name: 'behavioral_intent', score: 30, weight: 0.07, reasoning: '' },
    ]
    setAnthropicResponse(makeScoringResponse({ dimensions: dims }))
    const result = await scoreLead({ first_name: 'Cold' })
    expect(result.qualification).toBe('cold')
  })

  it('classifies as "unqualified" when total < 25', async () => {
    const dims = [
      { name: 'dental_condition', score: 10, weight: 0.22, reasoning: '' },
      { name: 'financial_readiness', score: 10, weight: 0.18, reasoning: '' },
      { name: 'urgency', score: 10, weight: 0.18, reasoning: '' },
      { name: 'engagement', score: 10, weight: 0.12, reasoning: '' },
      { name: 'demographics', score: 10, weight: 0.08, reasoning: '' },
      { name: 'source_quality', score: 10, weight: 0.07, reasoning: '' },
      { name: 'identity_confidence', score: 10, weight: 0.08, reasoning: '' },
      { name: 'behavioral_intent', score: 10, weight: 0.07, reasoning: '' },
    ]
    setAnthropicResponse(makeScoringResponse({ dimensions: dims }))
    const result = await scoreLead({ first_name: 'Bad' })
    expect(result.qualification).toBe('unqualified')
  })

  it('throws when AI response has no JSON', async () => {
    setAnthropicResponse('I cannot score this lead right now.')

    await expect(scoreLead({ first_name: 'Test' })).rejects.toThrow('Failed to parse AI scoring response')
  })

  it('extracts JSON from text with surrounding content', async () => {
    const json = makeScoringResponse()
    setAnthropicResponse(`Here is my scoring:\n${json}\nHope this helps!`)

    const result = await scoreLead({ first_name: 'Test' })
    expect(result.total_score).toBeGreaterThan(0)
  })

  it('logs HIPAA event when supabase and lead.id are provided', async () => {
    setAnthropicResponse(makeScoringResponse())

    const mockSupabase = {} as any
    await scoreLead(
      { id: 'lead-1', organization_id: 'org-1', first_name: 'Test' },
      mockSupabase
    )

    expect(logHIPAAEvent).toHaveBeenCalledWith(
      mockSupabase,
      expect.objectContaining({
        event_type: 'ai_scoring',
        resource_id: 'lead-1',
      })
    )
  })

  it('does not log HIPAA event when supabase is not provided', async () => {
    setAnthropicResponse(makeScoringResponse())

    await scoreLead({ first_name: 'Test' })

    expect(logHIPAAEvent).not.toHaveBeenCalled()
  })

  it('fetches enrichment data when supabase and lead.id are available', async () => {
    setAnthropicResponse(makeScoringResponse())

    const mockSupabase = {} as any
    await scoreLead({ id: 'lead-1', first_name: 'Test' }, mockSupabase)

    expect(getEnrichmentSummary).toHaveBeenCalledWith(mockSupabase, 'lead-1')
  })
})

// ═══════════════════════════════════════════════════════════════
// scoreLead — conversation context
//
// Urgency (0.18) + engagement (0.12) are 30% of the weighted score, and both
// live in the SMS thread rather than on the lead row. Scoring without the
// transcript graded them blind, which capped the entire scored population
// below the `warm` threshold and left `hot` permanently unreachable.
// ═══════════════════════════════════════════════════════════════

function supabaseWithMessages(rows: Array<Record<string, unknown>>) {
  return {
    from: (table: string) =>
      table === 'messages'
        ? {
            select: () => ({
              eq: () => ({
                order: () => ({ limit: () => Promise.resolve({ data: rows, error: null }) }),
              }),
            }),
          }
        : { select: () => ({ eq: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }) }) },
  } as any
}

function promptText() {
  return String(mockCreate.mock.calls[0][0].messages[0].content)
}

// ═══════════════════════════════════════════════════════════════
// weightedTotal — renormalization over observable dimensions
// ═══════════════════════════════════════════════════════════════

describe('weightedTotal', () => {
  const dim = (name: string, score: number, weight: number, observable?: boolean) => ({
    name, score, weight, reasoning: '', ...(observable === undefined ? {} : { observable }),
  })

  it('matches the plain weighted sum when every dimension is observable', () => {
    expect(weightedTotal([dim('a', 100, 0.5, true), dim('b', 50, 0.5, true)])).toBe(75)
  })

  it('treats a missing observable flag as observable (back-compat)', () => {
    expect(weightedTotal([dim('a', 100, 0.5), dim('b', 50, 0.5)])).toBe(75)
  })

  it('redistributes weight from unobservable dimensions', () => {
    // Observable: urgency + engagement + dental_condition = 0.52 of weight.
    // (80×.18 + 60×.12 + 30×.22) / 0.52 = 54 — vs 28 from the raw weighted sum,
    // where the five unobservable dimensions silently ate 48% of the scale.
    const dims = [
      dim('urgency', 80, 0.18, true),
      dim('engagement', 60, 0.12, true),
      dim('dental_condition', 30, 0.22, true),
      dim('financial_readiness', 20, 0.18, false),
      dim('demographics', 30, 0.08, false),
      dim('identity_confidence', 10, 0.08, false),
      dim('behavioral_intent', 30, 0.07, false),
      dim('source_quality', 50, 0.07, false),
    ]
    expect(weightedTotal(dims)).toBe(54)
  })

  it('lets a strong conversation reach hot when the rest is unknowable', () => {
    const dims = [
      dim('urgency', 95, 0.18, true),
      dim('engagement', 90, 0.12, true),
      dim('source_quality', 70, 0.07, true),
      dim('dental_condition', 30, 0.22, false),
      dim('financial_readiness', 20, 0.18, false),
      dim('demographics', 30, 0.08, false),
      dim('identity_confidence', 10, 0.08, false),
      dim('behavioral_intent', 30, 0.07, false),
    ]
    expect(weightedTotal(dims)).toBeGreaterThanOrEqual(75)
  })

  it('falls back to full weighting when too few dimensions are observable', () => {
    // Guard: one observable dimension must not carry a lead to hot.
    const dims = [
      dim('urgency', 100, 0.18, true),
      dim('engagement', 100, 0.12, false),
      dim('dental_condition', 20, 0.22, false),
      dim('financial_readiness', 20, 0.18, false),
      dim('demographics', 20, 0.08, false),
      dim('identity_confidence', 20, 0.08, false),
      dim('behavioral_intent', 20, 0.07, false),
      dim('source_quality', 20, 0.07, false),
    ]
    expect(weightedTotal(dims)).toBeLessThan(50)
  })

  it('returns 0 rather than dividing by zero on degenerate input', () => {
    expect(weightedTotal([])).toBe(0)
    expect(weightedTotal([dim('a', 90, 0, true)])).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════
// applyIntentFloor — ready_to_book promotes to hot
// ═══════════════════════════════════════════════════════════════

describe('applyIntentFloor', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()

  it('promotes a recently-engaged ready_to_book lead to hot', () => {
    expect(
      applyIntentFloor('cold', { conversation_intent: 'ready_to_book', last_responded_at: daysAgo(3) } as any)
    ).toBe('hot')
  })

  it('leaves other intents alone', () => {
    for (const intent of ['considering', 'exploring', 'resistant', 'disengaged']) {
      expect(
        applyIntentFloor('cold', { conversation_intent: intent, last_responded_at: daysAgo(3) } as any)
      ).toBe('cold')
    }
  })

  it('does not promote stale intent — ready_to_book five months ago', () => {
    expect(
      applyIntentFloor('cold', { conversation_intent: 'ready_to_book', last_responded_at: daysAgo(150) } as any)
    ).toBe('cold')
  })

  it('does not promote when the lead has never replied', () => {
    expect(
      applyIntentFloor('cold', { conversation_intent: 'ready_to_book', last_responded_at: null } as any)
    ).toBe('cold')
  })

  it('survives an unparseable timestamp without promoting', () => {
    expect(
      applyIntentFloor('warm', { conversation_intent: 'ready_to_book', last_responded_at: 'not-a-date' } as any)
    ).toBe('warm')
  })

  it('does not promote from unqualified — that is negative evidence, not missing evidence', () => {
    expect(
      applyIntentFloor('unqualified', {
        conversation_intent: 'ready_to_book',
        last_responded_at: daysAgo(1),
      } as any)
    ).toBe('unqualified')
  })

  it('never demotes a lead that already scored hot', () => {
    expect(applyIntentFloor('hot', { conversation_intent: 'disengaged' } as any)).toBe('hot')
  })
})

describe('scoreLead — intent floor integration', () => {
  it('flags intent_floored when the floor promotes the tier', async () => {
    const dims = [
      { name: 'dental_condition', score: 30, weight: 0.22, reasoning: '' },
      { name: 'financial_readiness', score: 30, weight: 0.18, reasoning: '' },
      { name: 'urgency', score: 40, weight: 0.18, reasoning: '' },
      { name: 'engagement', score: 40, weight: 0.12, reasoning: '' },
      { name: 'demographics', score: 30, weight: 0.08, reasoning: '' },
      { name: 'source_quality', score: 30, weight: 0.07, reasoning: '' },
      { name: 'identity_confidence', score: 30, weight: 0.08, reasoning: '' },
      { name: 'behavioral_intent', score: 30, weight: 0.07, reasoning: '' },
    ]
    setAnthropicResponse(makeScoringResponse({ dimensions: dims }))

    const result = await scoreLead({
      first_name: 'Cindy',
      conversation_intent: 'ready_to_book',
      last_responded_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    } as any)

    expect(result.qualification).toBe('hot')
    expect(result.intent_floored).toBe(true)
    // The raw score stays honest — it's the sort key within the hot group.
    expect(result.total_score).toBeLessThan(50)
  })

  it('leaves intent_floored false when the score earned the tier', async () => {
    setAnthropicResponse(makeScoringResponse()) // ~78 → hot on merit
    const result = await scoreLead({ first_name: 'Rich' })
    expect(result.qualification).toBe('hot')
    expect(result.intent_floored).toBe(false)
  })
})

describe('scoreLead — conversation context', () => {
  it('feeds the conversation transcript into the scoring prompt', async () => {
    setAnthropicResponse(makeScoringResponse())

    await scoreLead(
      { id: 'lead-1', first_name: 'Sarah' },
      supabaseWithMessages([
        { direction: 'outbound', body: 'Hi Sarah, are you still considering implants?', sender_type: 'ai', created_at: '2026-07-18T10:00:00Z' },
        { direction: 'inbound', body: 'Yes! I am in a lot of pain, can I come in this week?', sender_type: 'lead', created_at: '2026-07-18T10:04:00Z' },
      ])
    )

    const prompt = promptText()
    expect(prompt).toContain('in a lot of pain')
    expect(prompt).toContain('come in this week')
  })

  it('includes analyst-derived intent signals on the lead row', async () => {
    setAnthropicResponse(makeScoringResponse())

    await scoreLead(
      {
        id: 'lead-1',
        first_name: 'Sarah',
        conversation_intent: 'ready_to_book',
        conversation_sentiment: 'positive',
        primary_objection: 'cost',
      } as any,
      supabaseWithMessages([])
    )

    const prompt = promptText()
    expect(prompt).toContain('ready_to_book')
    expect(prompt).toContain('cost')
  })

  it('scores without a transcript when the lead has no messages', async () => {
    setAnthropicResponse(makeScoringResponse())

    const result = await scoreLead({ id: 'lead-1', first_name: 'Sarah' }, supabaseWithMessages([]))

    expect(result.total_score).toBeGreaterThan(0)
    expect(promptText()).not.toContain('<conversation_history>')
  })

  it('still scores when the message fetch throws', async () => {
    setAnthropicResponse(makeScoringResponse())

    const broken = {
      from: () => {
        throw new Error('connection reset')
      },
    } as any

    const result = await scoreLead({ id: 'lead-1', first_name: 'Sarah' }, broken)
    expect(result.total_score).toBeGreaterThan(0)
  })
})

// ═══════════════════════════════════════════════════════════════
// rescoreAndPersistLead
// ═══════════════════════════════════════════════════════════════

describe('rescoreAndPersistLead', () => {
  const lead = { id: 'lead-1', organization_id: 'org-1', first_name: 'Test' }

  beforeEach(() => {
    mockInsert.mockResolvedValue({ error: null })
  })

  it('persists the score and logs activity + interaction when the write lands', async () => {
    setAnthropicResponse(makeScoringResponse())
    mockMaybeSingle.mockResolvedValue({ data: { id: 'lead-1' }, error: null })

    const result = await rescoreAndPersistLead({} as any, lead)

    expect(result.total_score).toBeGreaterThan(0)
    expect(mockInsert).toHaveBeenCalledTimes(2) // lead_activities + ai_interactions
  })

  it('throws instead of silently succeeding when the write matches 0 rows (RLS/cross-org no-op)', async () => {
    setAnthropicResponse(makeScoringResponse())
    mockMaybeSingle.mockResolvedValue({ data: null, error: null })

    await expect(rescoreAndPersistLead({} as any, lead)).rejects.toThrow('not persisted')
    // The exact bug this guards: no phantom "AI Score" activity when the score never landed.
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('throws when the update returns an error', async () => {
    setAnthropicResponse(makeScoringResponse())
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: 'boom' } })

    await expect(rescoreAndPersistLead({} as any, lead)).rejects.toThrow('Failed to persist lead score: boom')
  })

  it('throws before scoring when organization_id is missing', async () => {
    await expect(
      rescoreAndPersistLead({} as any, { id: 'lead-1', first_name: 'Test' })
    ).rejects.toThrow('requires lead.id and lead.organization_id')
    expect(mockCreate).not.toHaveBeenCalled() // never even calls the model
  })
})

// ═══════════════════════════════════════════════════════════════
// generateLeadEngagement
// ═══════════════════════════════════════════════════════════════

describe('generateLeadEngagement', () => {
  it('returns a message and confidence for education mode', async () => {
    setAnthropicResponse('Great question! The All-on-4 is a fantastic option.')

    const result = await generateLeadEngagement(
      { first_name: 'Sarah' },
      [{ role: 'user', content: 'Tell me about implants' }],
      { mode: 'education', channel: 'sms' }
    )

    expect(result.message).toBeTruthy()
    expect(result.confidence).toBe(0.85)
  })

  it('reduces confidence when HIPAA violation detected', async () => {
    setAnthropicResponse('Your SSN is 123-45-6789. Call Dr. Smith.')

    vi.mocked(checkResponseCompliance).mockReturnValue([
      { category: 'ssn', severity: 'critical', description: 'SSN found', remediation: 'Remove SSN from response' },
    ])

    const result = await generateLeadEngagement(
      { first_name: 'Sarah', organization_id: 'org-1' },
      [{ role: 'user', content: 'What info do you need?' }],
      { mode: 'education', channel: 'email' },
      {} as any // supabase
    )

    expect(result.confidence).toBe(0.5)
  })

  it('logs compliance issues when supabase is available', async () => {
    setAnthropicResponse('Some response')

    vi.mocked(checkResponseCompliance).mockReturnValue([
      { category: 'name', severity: 'warning', description: 'Full name found', remediation: 'Remove full name from response' },
    ])

    const mockSupabase = {} as any
    await generateLeadEngagement(
      { first_name: 'Sarah', organization_id: 'org-1', id: 'lead-1' },
      [{ role: 'user', content: 'Hi' }],
      { mode: 'follow_up', channel: 'email' },
      mockSupabase
    )

    expect(logHIPAAEvent).toHaveBeenCalledWith(
      mockSupabase,
      expect.objectContaining({
        event_type: 'ai_compliance_warning',
      })
    )
  })

  it('generates engagement for all modes', async () => {
    const modes = ['education', 'objection_handling', 'appointment_scheduling', 'follow_up'] as const

    for (const mode of modes) {
      mockCreate.mockClear()
      vi.mocked(checkResponseCompliance).mockReturnValue([])
      setAnthropicResponse(`Response for ${mode}`)

      const result = await generateLeadEngagement(
        { first_name: 'Test' },
        [{ role: 'user', content: 'Hello' }],
        { mode, channel: 'sms' }
      )

      expect(result.message).toBeTruthy()
    }
  })

  it('works with both sms and email channels', async () => {
    for (const channel of ['sms', 'email'] as const) {
      mockCreate.mockClear()
      vi.mocked(checkResponseCompliance).mockReturnValue([])
      setAnthropicResponse(`Response for ${channel}`)

      const result = await generateLeadEngagement(
        { first_name: 'Test' },
        [{ role: 'user', content: 'Hello' }],
        { mode: 'education', channel }
      )

      expect(result.message).toBeTruthy()
    }
  })

  // Fresh outreach (compose dialog, campaign send) has no prior messages. The
  // Anthropic Messages API rejects an empty `messages` array with a 400, so the
  // engagement generator must seed an opening-message turn.
  it('sends a non-empty messages array when there is no conversation history', async () => {
    setAnthropicResponse('Hi Sarah — quick note about All-on-4.')

    const result = await generateLeadEngagement(
      { first_name: 'Sarah' },
      [], // no history — first-touch outreach
      { mode: 'education', channel: 'sms' }
    )

    expect(result.message).toBeTruthy()
    const callArgs = mockCreate.mock.calls[0][0]
    expect(callArgs.messages.length).toBeGreaterThan(0)
    expect(callArgs.messages[0].role).toBe('user')
  })

  // ── Anti-generic guardrails ──────────────────────────────────
  // These assert the PROMPT the model receives, not model output (the model is
  // mocked). They pin the behavior that keeps drafts from reading like a mass
  // blast: the human texting-style layer, the bot-tell bans, and a first-touch
  // opener that must lean on the lead's own profile.

  it('injects the human texting-style block for SMS but not email', async () => {
    vi.mocked(checkResponseCompliance).mockReturnValue([])

    setAnthropicResponse('sms draft')
    await generateLeadEngagement(
      { first_name: 'Sarah' },
      [{ role: 'user', content: 'yes' }, { role: 'user', content: 'how much' }],
      { mode: 'education', channel: 'sms' }
    )
    expect(mockCreate.mock.calls[0][0].system).toContain("THIS PATIENT'S TEXTING STYLE")

    mockCreate.mockClear()
    setAnthropicResponse('email draft')
    await generateLeadEngagement(
      { first_name: 'Sarah' },
      [{ role: 'user', content: 'yes' }],
      { mode: 'education', channel: 'email' }
    )
    expect(mockCreate.mock.calls[0][0].system).not.toContain("THIS PATIENT'S TEXTING STYLE")
  })

  it('bans the classic bot-tell filler phrases in the system prompt', async () => {
    vi.mocked(checkResponseCompliance).mockReturnValue([])
    setAnthropicResponse('draft')

    await generateLeadEngagement(
      { first_name: 'Sarah' },
      [{ role: 'user', content: 'hi' }],
      { mode: 'follow_up', channel: 'sms' }
    )

    const system: string = mockCreate.mock.calls[0][0].system
    expect(system).toContain('I hope this message finds you well')
    expect(system).toContain('Feel free to reach out')
    expect(system.toLowerCase()).toContain('bot-tell')
  })

  it('first-touch seed instruction demands lead-specific opener, not a generic greeting', async () => {
    vi.mocked(checkResponseCompliance).mockReturnValue([])
    setAnthropicResponse('draft')

    await generateLeadEngagement(
      { first_name: 'Sarah' },
      [], // first touch
      { mode: 'appointment_scheduling', channel: 'sms' }
    )

    const seed: string = mockCreate.mock.calls[0][0].messages[0].content
    expect(seed).toMatch(/specific/i)
    expect(seed).toMatch(/one easy question/i)
  })
})
