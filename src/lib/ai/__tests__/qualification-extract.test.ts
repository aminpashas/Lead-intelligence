import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCreate = vi.fn()
vi.mock('@anthropic-ai/sdk', () => {
  // APIError must be a real class on the mock: the code under test branches on
  // `err instanceof Anthropic.APIError` to tell a systemic outage apart from a
  // per-lead failure, and a mock without it would make that branch untestable
  // (and silently always-false).
  class MockAPIError extends Error {}
  class MockAnthropic {
    static APIError = MockAPIError
    messages = { create: mockCreate }
    constructor(_opts?: unknown) {}
  }
  return { default: MockAnthropic, __esModule: true }
})

vi.mock('@/lib/ai/hipaa', () => ({
  buildSafeConversationHistory: vi.fn((msgs: Array<{ direction: string; body: string }>) =>
    msgs.map((m) => ({ role: m.direction === 'inbound' ? 'user' : 'assistant', content: m.body }))
  ),
}))

import Anthropic from '@anthropic-ai/sdk'
import { extractQualificationFromTranscript } from '@/lib/ai/qualification-extract'

function supabaseWith(rows: Array<Record<string, unknown>>) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => ({ limit: () => Promise.resolve({ data: rows, error: null }) }),
        }),
      }),
    }),
  } as never
}

const msgs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    direction: i % 2 ? 'inbound' : 'outbound',
    body: `message ${i}`,
    sender_type: 'lead',
    created_at: `2026-07-0${(i % 9) + 1}T00:00:00Z`,
  }))

function respond(text: string) {
  mockCreate.mockResolvedValue({ content: [{ type: 'text', text }] })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.ANTHROPIC_API_KEY = 'test-key'
})

describe('extractQualificationFromTranscript', () => {
  it('returns the facts found in the transcript', async () => {
    respond('{"dental_condition":"missing_all_upper","financing_interest":"financing_needed","credit_range":null,"timeline_note":"next month"}')

    const result = await extractQualificationFromTranscript(supabaseWith(msgs(12)), 'lead-1')

    expect(result).toMatchObject({
      dental_condition: 'missing_all_upper',
      financing_interest: 'financing_needed',
      timeline_note: 'next month',
    })
  })

  it('does not call the model for a thread below minMessages', async () => {
    const result = await extractQualificationFromTranscript(supabaseWith(msgs(3)), 'lead-1', {
      minMessages: 8,
    })

    expect(result).toBeNull()
    // The whole cost argument for the backfill rests on short threads never
    // reaching the model — measured yield below 4 messages was zero.
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('returns null when the model finds nothing, rather than an empty object', async () => {
    respond('{"dental_condition":null,"financing_interest":null,"credit_range":null,"timeline_note":null}')
    expect(await extractQualificationFromTranscript(supabaseWith(msgs(12)), 'lead-1')).toBeNull()
  })

  it('returns null on unparseable model output instead of throwing', async () => {
    respond('I could not determine the qualification facts.')
    expect(await extractQualificationFromTranscript(supabaseWith(msgs(12)), 'lead-1')).toBeNull()
  })

  it('returns null on a generic throw — one bad lead must not abort a batch', async () => {
    mockCreate.mockRejectedValue(new Error('something odd'))
    expect(await extractQualificationFromTranscript(supabaseWith(msgs(12)), 'lead-1')).toBeNull()
  })

  it('RETHROWS Anthropic.APIError so the caller aborts without stamping', async () => {
    // Regression: collapsing an API outage into `null` made "the API was down"
    // indistinguishable from "nothing to find". The caller stamps
    // qualification_backfilled_at on every processed lead, so on the first
    // production run a credit outage permanently retired 202 long-thread leads
    // that were never actually examined.
    // Cast: the mocked APIError is a plain Error subclass, while the real SDK
    // type demands (status, error, message, headers). Only `instanceof` matters
    // to the code under test.
    const APIErrorCtor = Anthropic.APIError as unknown as new (m: string) => Error
    mockCreate.mockRejectedValue(new APIErrorCtor('credit balance is too low'))

    await expect(
      extractQualificationFromTranscript(supabaseWith(msgs(12)), 'lead-1')
    ).rejects.toThrow('credit balance is too low')
  })

  it('drops non-string values rather than passing them to the enum validator', async () => {
    respond('{"dental_condition":42,"financing_interest":"cash_pay","credit_range":{},"timeline_note":null}')

    const result = await extractQualificationFromTranscript(supabaseWith(msgs(12)), 'lead-1')

    expect(result).toMatchObject({ dental_condition: null, financing_interest: 'cash_pay', credit_range: null })
  })
})
