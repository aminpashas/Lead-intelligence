import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the tool executor so the loop test never touches real I/O.
const executeAgentTool = vi.fn()
vi.mock('@/lib/autopilot/agent-tools', () => ({
  executeAgentTool: (...args: unknown[]) => executeAgentTool(...args),
}))

import { runAgentToolLoop, deriveConfidence, MAX_AGENT_ROUNDS } from '@/lib/ai/agent-loop'

function toolUse(id: string, name: string, input: Record<string, unknown> = {}) {
  return { type: 'tool_use' as const, id, name, input }
}
function text(t: string) {
  return { type: 'text' as const, text: t }
}
function msg(stop_reason: string, content: unknown[], usage = { input_tokens: 10, output_tokens: 5 }) {
  return { stop_reason, content, usage }
}

/** Fake Anthropic whose messages.create returns a queued sequence of responses. */
function fakeAnthropic(queue: unknown[]) {
  const create = vi.fn(async () => queue.shift())
  return { client: { messages: { create } } as never, create }
}

const baseParams = {
  supabase: {} as never,
  model: 'claude-sonnet-4-20250514',
  maxTokens: 512,
  system: 'sys',
  messages: [{ role: 'user' as const, content: 'hi' }],
  tools: [],
  toolContext: { organization_id: 'org', lead_id: 'lead', lead: {}, conversation_id: 'conv', channel: 'sms' },
}

describe('runAgentToolLoop', () => {
  beforeEach(() => {
    executeAgentTool.mockReset()
    executeAgentTool.mockResolvedValue({ success: true, message: 'ok' })
  })

  it('chains multiple tool rounds until the model stops, summing usage', async () => {
    const { client } = fakeAnthropic([
      msg('tool_use', [toolUse('t1', 'check_availability')]),
      msg('tool_use', [toolUse('t2', 'create_booking')]),
      msg('end_turn', [text('{"message":"booked"}')]),
    ])

    const result = await runAgentToolLoop({ ...baseParams, anthropic: client })

    expect(result.rounds).toBe(2)
    expect(result.hitRoundCap).toBe(false)
    expect(result.toolCalls.map((t) => t.name)).toEqual(['check_availability', 'create_booking'])
    expect(result.responseText).toContain('booked')
    expect(executeAgentTool).toHaveBeenCalledTimes(2)
    // usage summed across all 3 model calls
    expect(result.usage).toEqual({ input_tokens: 30, output_tokens: 15 })
  })

  it('returns immediately when the first response needs no tools', async () => {
    const { client } = fakeAnthropic([msg('end_turn', [text('hello')])])
    const result = await runAgentToolLoop({ ...baseParams, anthropic: client })
    expect(result.rounds).toBe(0)
    expect(result.toolCalls).toHaveLength(0)
    expect(result.responseText).toBe('hello')
  })

  it('stops at the round cap and flags hitRoundCap when the model never stops', async () => {
    // Always asks for another tool — would loop forever without the cap.
    const { client, create } = fakeAnthropic([])
    create.mockResolvedValue(msg('tool_use', [toolUse('t', 'check_availability')]))

    const result = await runAgentToolLoop({ ...baseParams, anthropic: client, maxRounds: 3 })

    expect(result.rounds).toBe(3)
    expect(result.hitRoundCap).toBe(true)
    expect(executeAgentTool).toHaveBeenCalledTimes(3)
  })

  it('default cap is MAX_AGENT_ROUNDS', () => {
    expect(MAX_AGENT_ROUNDS).toBe(5)
  })
})

describe('deriveConfidence', () => {
  it('passes through a calibrated model score, clamped to [0,1]', () => {
    expect(deriveConfidence({ selfConfidence: 0.82, hasCriticalCompliance: false, hitRoundCap: false })).toBe(0.82)
    expect(deriveConfidence({ selfConfidence: 1.4, hasCriticalCompliance: false, hitRoundCap: false })).toBe(1)
    expect(deriveConfidence({ selfConfidence: -0.2, hasCriticalCompliance: false, hitRoundCap: false })).toBe(0)
  })

  it('falls back to a middling default when the model omits a usable number', () => {
    expect(deriveConfidence({ selfConfidence: undefined, hasCriticalCompliance: false, hitRoundCap: false })).toBe(0.7)
    expect(deriveConfidence({ selfConfidence: 'high', hasCriticalCompliance: false, hitRoundCap: false })).toBe(0.7)
    expect(deriveConfidence({ selfConfidence: NaN, hasCriticalCompliance: false, hitRoundCap: false })).toBe(0.7)
  })

  it('caps confidence on a critical compliance issue so the autopilot escalates', () => {
    expect(deriveConfidence({ selfConfidence: 0.99, hasCriticalCompliance: true, hitRoundCap: false })).toBe(0.4)
  })

  it('caps confidence when an action was left unfinished at the round cap', () => {
    expect(deriveConfidence({ selfConfidence: 0.95, hasCriticalCompliance: false, hitRoundCap: true })).toBe(0.5)
  })

  it('applies the strictest guardrail when several fire', () => {
    expect(deriveConfidence({ selfConfidence: 0.95, hasCriticalCompliance: true, hitRoundCap: true })).toBe(0.4)
  })
})
