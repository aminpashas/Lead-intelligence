import { describe, it, expect } from 'vitest'
import {
  formatAppointmentWhen,
  buildAlreadyBookedBlock,
  type UpcomingAppointment,
} from '@/lib/appointments/upcoming'

const TZ = 'America/Los_Angeles'

// The bug: the setter re-offered slots after confirming Wed Jul 15 @ 10 AM.
// The fix injects an "already booked" block built from the real appointment.
const bookedWed10am: UpcomingAppointment = {
  id: 'apt-1',
  // 10:00 AM Pacific on Wed Jul 15 2026 = 17:00 UTC
  scheduled_at: '2026-07-15T17:00:00Z',
  location: '450 Sutter St, Suite 1519',
  status: 'scheduled',
  confirmation_received: true,
}

describe('formatAppointmentWhen', () => {
  it('renders the full slot in practice-local time', () => {
    expect(formatAppointmentWhen(bookedWed10am.scheduled_at, TZ)).toBe(
      'Wednesday, July 15 at 10:00 AM'
    )
  })

  it('falls back to the default practice timezone when none given', () => {
    // Default TZ is America/Los_Angeles, so this must match the explicit-TZ render.
    expect(formatAppointmentWhen(bookedWed10am.scheduled_at, null)).toBe(
      'Wednesday, July 15 at 10:00 AM'
    )
  })
})

describe('buildAlreadyBookedBlock', () => {
  it('returns empty string when the patient has no upcoming appointment', () => {
    expect(buildAlreadyBookedBlock(null, TZ)).toBe('')
  })

  it('names the confirmed time and forbids re-scheduling', () => {
    const block = buildAlreadyBookedBlock(bookedWed10am, TZ)
    expect(block).toContain('ALREADY BOOKED')
    expect(block).toContain('Wednesday, July 15 at 10:00 AM')
    expect(block).toContain('450 Sutter St, Suite 1519')
    // The core guard: do not re-open scheduling.
    expect(block).toContain('check_availability')
    expect(block).toContain('create_booking')
    // A bare "yes"/"either works" must be read as agreeing with the existing time.
    expect(block.toLowerCase()).toContain('either works')
  })

  it('omits the location clause when the appointment has no location', () => {
    const block = buildAlreadyBookedBlock({ ...bookedWed10am, location: null }, TZ)
    expect(block).toContain('Wednesday, July 15 at 10:00 AM')
    expect(block).not.toContain(' at 450 Sutter')
  })

  it('hands over the self-serve reschedule link when provided', () => {
    const url = 'https://app.test/reschedule?token=abc'
    const block = buildAlreadyBookedBlock(bookedWed10am, TZ, { rescheduleUrl: url })
    expect(block).toContain(url)
    expect(block).toContain('paste this self-serve reschedule link')
  })

  it('falls back to coordinator wording when no reschedule link', () => {
    const block = buildAlreadyBookedBlock(bookedWed10am, TZ, { rescheduleUrl: null })
    expect(block).toContain('coordinator will help')
    expect(block).not.toContain('reschedule?token')
  })
})
