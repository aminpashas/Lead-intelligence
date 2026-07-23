import { describe, it, expect } from 'vitest'
import {
  formatAppointmentWhen,
  buildAlreadyBookedBlock,
  isProtectedPatient,
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

  it('protected variant never hands over a self-serve link, even if one is passed', () => {
    const url = 'https://app.test/reschedule?token=abc'
    const block = buildAlreadyBookedBlock(bookedWed10am, TZ, {
      rescheduleUrl: url,
      protected: true,
    })
    // The link must NOT leak to a post-consult / mid-treatment patient.
    expect(block).not.toContain(url)
    // ...and the agent is not instructed to paste any link (the non-protected leak path).
    expect(block).not.toContain('paste this self-serve reschedule link')
    // Change requests become a coordinator handoff.
    expect(block).toContain('treatment coordinator')
  })

  it('protected variant forbids implying the change is already done', () => {
    const block = buildAlreadyBookedBlock(bookedWed10am, TZ, { protected: true })
    expect(block).toContain('do NOT imply it is handled')
    expect(block).toContain('still STANDS')
    // References the non-refundable financial policy without quoting figures.
    expect(block).toContain('non-refundable deposit')
    expect(block).toContain('do NOT quote specific dollar amounts')
  })

  it('protected variant bans proactive "still a good time?" prompts', () => {
    const block = buildAlreadyBookedBlock(bookedWed10am, TZ, { protected: true })
    expect(block).toContain('Never PROACTIVELY ask')
    expect(block).toContain('still works')
    expect(block).toContain('DO NOT RE-SCHEDULE OR CANCEL')
  })
})

describe('isProtectedPatient', () => {
  it('is true from the completed consultation onward', () => {
    for (const s of [
      'consultation_completed',
      'treatment_presented',
      'financing',
      'contract_sent',
      'contract_signed',
      'scheduled',
      'in_treatment',
    ]) {
      expect(isProtectedPatient(s)).toBe(true)
    }
  })

  it('is false for pre-consult and terminal statuses', () => {
    for (const s of [
      'new',
      'contacted',
      'qualified',
      'consultation_scheduled',
      'no_show',
      'unresponsive',
      'dormant',
      'completed',
      'lost',
      'disqualified',
    ]) {
      expect(isProtectedPatient(s)).toBe(false)
    }
  })

  it('is false for null/undefined', () => {
    expect(isProtectedPatient(null)).toBe(false)
    expect(isProtectedPatient(undefined)).toBe(false)
  })
})
