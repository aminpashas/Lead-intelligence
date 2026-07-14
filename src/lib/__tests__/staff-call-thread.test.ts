import { describe, it, expect } from 'vitest'
import { buildStaffCallSummary } from '@/lib/voice/staff-call-thread'

describe('buildStaffCallSummary', () => {
  it('shows talk time for an answered outbound call', () => {
    expect(buildStaffCallSummary('outbound', 'completed', 29)).toBe(
      'Outbound call — completed · 29s'
    )
  })

  it('formats durations over a minute as m/ss', () => {
    expect(buildStaffCallSummary('inbound', 'completed', 185)).toBe(
      'Inbound call — completed · 3m 05s'
    )
  })

  it('renders "ended" for a completed call with no talk time', () => {
    expect(buildStaffCallSummary('outbound', 'completed', 0)).toBe('Outbound call — ended')
  })

  it('labels the unanswered outcomes without a duration', () => {
    expect(buildStaffCallSummary('outbound', 'no_answer', 0)).toBe('Outbound call — no answer')
    expect(buildStaffCallSummary('outbound', 'busy', 0)).toBe('Outbound call — busy')
    expect(buildStaffCallSummary('outbound', 'failed', 0)).toBe('Outbound call — failed')
    expect(buildStaffCallSummary('outbound', 'canceled', 0)).toBe('Outbound call — canceled')
  })

  it('falls back to the raw status for anything unmapped', () => {
    expect(buildStaffCallSummary('inbound', 'in_progress', 0)).toBe('Inbound call — in_progress')
  })
})
