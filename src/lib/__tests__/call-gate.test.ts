import { describe, it, expect } from 'vitest'
import {
  isCallGateEnabled,
  isQualifyingCall,
  hasQualifyingCall,
  type QualifyingCallRow,
} from '@/lib/booking/call-gate'

const call = (over: Partial<QualifyingCallRow>): QualifyingCallRow => ({
  status: 'completed',
  outcome: 'interested',
  duration_seconds: 120,
  ...over,
})

describe('isCallGateEnabled', () => {
  it('true only when require_call_before_booking === true', () => {
    expect(isCallGateEnabled({ require_call_before_booking: true })).toBe(true)
    expect(isCallGateEnabled({ require_call_before_booking: false })).toBe(false)
    expect(isCallGateEnabled({})).toBe(false)
    expect(isCallGateEnabled(null)).toBe(false)
    expect(isCallGateEnabled(undefined)).toBe(false)
  })
})

describe('isQualifyingCall — positive-intent policy', () => {
  it('completed + positive outcome qualifies', () => {
    expect(isQualifyingCall(call({ outcome: 'appointment_booked' }))).toBe(true)
    expect(isQualifyingCall(call({ outcome: 'interested' }))).toBe(true)
    expect(isQualifyingCall(call({ outcome: 'callback_requested' }))).toBe(true)
  })

  it('a flat not_interested does NOT unlock booking', () => {
    expect(isQualifyingCall(call({ outcome: 'not_interested' }))).toBe(false)
  })

  it('non-conversation outcomes never qualify', () => {
    for (const outcome of ['voicemail_left', 'no_answer', 'wrong_number', 'do_not_call', 'technical_failure', 'transferred'] as const) {
      expect(isQualifyingCall(call({ outcome }))).toBe(false)
    }
  })

  it('a null outcome never qualifies', () => {
    expect(isQualifyingCall(call({ outcome: null }))).toBe(false)
  })

  it('only completed calls qualify (in_progress / no_answer do not)', () => {
    expect(isQualifyingCall(call({ status: 'in_progress' }))).toBe(false)
    expect(isQualifyingCall(call({ status: 'no_answer', outcome: 'interested' }))).toBe(false)
  })
})

/** Minimal thenable Supabase stub: from().select().eq()… resolves to {data,error}. */
function mockSupabase(rows: unknown[] | null, error: unknown = null) {
  const builder: Record<string, unknown> = {
    from: () => builder,
    select: () => builder,
    eq: () => builder,
    then: (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
      resolve({ data: error ? null : rows, error }),
  }
  return builder as never
}

describe('hasQualifyingCall', () => {
  it('true when at least one completed positive-intent call exists', async () => {
    const sb = mockSupabase([{ status: 'completed', outcome: 'interested', duration_seconds: 90 }])
    expect(await hasQualifyingCall(sb, 'org', 'lead')).toBe(true)
  })

  it('false when the lead only has non-qualifying calls', async () => {
    const sb = mockSupabase([
      { status: 'completed', outcome: 'not_interested', duration_seconds: 30 },
      { status: 'completed', outcome: 'voicemail_left', duration_seconds: 5 },
    ])
    expect(await hasQualifyingCall(sb, 'org', 'lead')).toBe(false)
  })

  it('fails CLOSED on a query error (never waves a booking through)', async () => {
    const sb = mockSupabase(null, { message: 'boom' })
    expect(await hasQualifyingCall(sb, 'org', 'lead')).toBe(false)
  })

  it('false when there are no calls at all', async () => {
    const sb = mockSupabase([])
    expect(await hasQualifyingCall(sb, 'org', 'lead')).toBe(false)
  })
})
