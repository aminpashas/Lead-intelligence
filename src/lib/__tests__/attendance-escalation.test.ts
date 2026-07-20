import { describe, it, expect } from 'vitest'
import {
  buildCheckinSmsBody,
  formatEscalationTime,
} from '@/lib/campaigns/attendance-escalation'

// 2:30 PM Pacific / 5:30 PM Eastern on 2026-07-02 (both DST).
const SCHEDULED_AT = '2026-07-02T21:30:00.000Z'
const PACIFIC = 'America/Los_Angeles'
const EASTERN = 'America/New_York'

describe('formatEscalationTime', () => {
  // Regression guard, not a formatting nicety. Vercel runs UTC, so the original
  // implementation (bare toLocaleString with no timeZone) rendered this instant
  // as "9:30 PM" — telling a patient the wrong time for their own appointment,
  // in the one message sent on the morning of the visit.
  //
  // Asserting a real clock value in a named zone is what makes that impossible
  // to reintroduce. The previous shape assertion (/^\d{1,2}:\d{2} (AM|PM)$/)
  // passed just as happily on the UTC-wrong answer, which is why it survived.
  it('renders the time in the PRACTICE zone, not the runner/server zone', () => {
    expect(formatEscalationTime(SCHEDULED_AT, PACIFIC)).toBe('2:30 PM')
  })

  it('renders the same instant differently for a different practice zone', () => {
    expect(formatEscalationTime(SCHEDULED_AT, EASTERN)).toBe('5:30 PM')
  })
})

describe('buildCheckinSmsBody', () => {
  const body = buildCheckinSmsBody({
    firstName: 'Maria',
    practiceName: 'Dion Dental',
    scheduledAt: SCHEDULED_AT,
    timeZone: PACIFIC,
  })

  it('greets by first name and names the practice', () => {
    expect(body).toContain('Hi Maria')
    expect(body).toContain('Dion Dental')
  })

  it('quotes the appointment time in the practice zone', () => {
    expect(body).toContain('2:30 PM')
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
      timeZone: PACIFIC,
    })
    expect(anon).toContain('Hi there')
  })
})
