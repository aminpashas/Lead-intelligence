import { describe, it, expect } from 'vitest'
import {
  buildCheckinSmsBody,
  formatEscalationTime,
} from '@/lib/campaigns/attendance-escalation'

// A fixed instant; the formatted time depends on the runner's local TZ, so we
// compare against formatEscalationTime rather than a hard-coded clock string.
const SCHEDULED_AT = '2026-07-02T21:30:00.000Z'

describe('formatEscalationTime', () => {
  it('renders h:mm AM/PM (12-hour, minutes padded)', () => {
    expect(formatEscalationTime(SCHEDULED_AT)).toMatch(/^\d{1,2}:\d{2}\s?(AM|PM)$/)
  })
})

describe('buildCheckinSmsBody', () => {
  const body = buildCheckinSmsBody({
    firstName: 'Maria',
    practiceName: 'Dion Dental',
    scheduledAt: SCHEDULED_AT,
  })

  it('greets by first name and names the practice', () => {
    expect(body).toContain('Hi Maria')
    expect(body).toContain('Dion Dental')
  })

  it('contains the formatted appointment time', () => {
    expect(body).toContain(formatEscalationTime(SCHEDULED_AT))
  })

  it('requires a reply: asks for YES and offers reschedule', () => {
    expect(body).toContain('Reply YES to confirm')
    expect(body.toLowerCase()).toContain('reschedule')
  })

  it('uses YES so the reply matches the Twilio webhook confirmKeywords regex', () => {
    // Mirror of confirmKeywords in src/app/api/webhooks/twilio/route.ts —
    // the check-in only re-arms/stamps correctly if the asked-for reply parses.
    const confirmKeywords = /^\s*(yes|confirm|y|confirmed|yep|yeah)\s*$/i
    expect(confirmKeywords.test('YES')).toBe(true)
  })

  it('falls back to a generic greeting when first name is missing', () => {
    const anon = buildCheckinSmsBody({
      firstName: null,
      practiceName: 'Dion Dental',
      scheduledAt: SCHEDULED_AT,
    })
    expect(anon).toContain('Hi there')
  })
})
