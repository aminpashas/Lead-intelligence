import { describe, it, expect } from 'vitest'
import { shouldRefreshCallActivity } from '../conversations'

describe('shouldRefreshCallActivity', () => {
  it('refreshes the real-world Rico case: stored ring-time snapshot, GHL now reports a connected call', () => {
    // Exactly what was stored for Heather's call: GHL status "ringing" mapped to
    // 'unknown' with no duration, while the call actually ran 258 seconds.
    expect(
      shouldRefreshCallActivity(
        { call_state: 'unknown', duration_seconds: null },
        { state: 'answered', durationSec: 258 }
      )
    ).toBe(true)
  })

  it('refreshes legacy rows that carry neither key', () => {
    expect(shouldRefreshCallActivity({}, { state: 'answered', durationSec: 25 })).toBe(true)
  })

  it('refreshes when only the duration is newly known', () => {
    expect(
      shouldRefreshCallActivity(
        { call_state: 'answered', duration_seconds: null },
        { state: 'answered', durationSec: 42 }
      )
    ).toBe(true)
  })

  it('never downgrades a terminal row from a thinner later payload', () => {
    expect(
      shouldRefreshCallActivity(
        { call_state: 'answered', duration_seconds: 258 },
        { state: 'unknown', durationSec: null }
      )
    ).toBe(false)
  })

  it('leaves a settled terminal row alone when nothing changed', () => {
    expect(
      shouldRefreshCallActivity(
        { call_state: 'no_answer', duration_seconds: 0 },
        { state: 'no_answer', durationSec: null }
      )
    ).toBe(false)
  })

  it('does not rewrite a provisional row when GHL still knows nothing new', () => {
    // Re-polling a call that is genuinely still ringing must not churn the row.
    expect(
      shouldRefreshCallActivity(
        { call_state: 'unknown', duration_seconds: null },
        { state: 'unknown', durationSec: null }
      )
    ).toBe(false)
  })

  it('treats a terminal state with a real duration as settled', () => {
    expect(
      shouldRefreshCallActivity(
        { call_state: 'voicemail', duration_seconds: 12 },
        { state: 'voicemail', durationSec: 12 }
      )
    ).toBe(false)
  })
})
