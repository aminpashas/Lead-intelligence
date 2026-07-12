import { describe, it, expect } from 'vitest'
import { formatAppointmentDateTime } from '@/lib/campaigns/reminders'

// Regression: appointment reminder/confirmation emails rendered the time in the
// server's ambient timezone (UTC on Vercel) instead of the practice's zone, so
// an 11:00 AM Pacific consult showed up as "6:00 PM" in the confirmation email.
// formatAppointmentDateTime must pin the output to the passed IANA timezone,
// independent of the machine the code runs on.
describe('formatAppointmentDateTime', () => {
  // 2026-07-15 18:00 UTC == 11:00 AM PDT (UTC-7) == 2:00 PM EDT (UTC-4)
  const instant = '2026-07-15T18:00:00Z'

  it('renders the wall-clock time in the practice (Pacific) timezone', () => {
    expect(formatAppointmentDateTime(instant, 'America/Los_Angeles')).toBe(
      'Wednesday, July 15 at 11:00 AM'
    )
  })

  it('renders the same instant differently in another timezone', () => {
    expect(formatAppointmentDateTime(instant, 'America/New_York')).toBe(
      'Wednesday, July 15 at 2:00 PM'
    )
  })

  it('is deterministic regardless of the ambient machine timezone', () => {
    // The two zones are 3 hours apart; if the formatter ignored its timeZone
    // argument (the original bug) both calls would return the same string.
    const pacific = formatAppointmentDateTime(instant, 'America/Los_Angeles')
    const eastern = formatAppointmentDateTime(instant, 'America/New_York')
    expect(pacific).not.toBe(eastern)
  })
})
