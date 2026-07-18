/**
 * Patient-safety regression tests for autopilot.
 *
 * Covers three production incidents:
 *   (a) FIX 2 — forbidden medical claims / price quotes must be HARD-BLOCKED from
 *       sending when an AI-generated, lead-facing send sets blockOnReview:true.
 *   (b) FIX 1 — quiet hours must be evaluated in the org's local timezone, not UTC,
 *       so an 11pm-Eastern timestamp falls outside an 8-21 window.
 *   (c) FIX 4 — stop-word detection must use whole-word boundaries: "cancel" must
 *       NOT fire inside "don't cancel my appt", while "stop" / "opt out" still do.
 */

import { describe, it, expect, vi } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { sendSMSToLead } from '@/lib/messaging/twilio'
import { sendEmailToLead } from '@/lib/messaging/resend'
import { detectStopWord, getLocalHourAndDay } from '@/lib/autopilot/config'
import { isServiceOutage } from '@/lib/autopilot/auto-respond'

// NOTE on transport: blocked content returns { sent: false } BEFORE any Twilio /
// Resend client is touched, so these tests never hit the network. We assert the
// block decision (and reason) directly — that is the safety guarantee under test.

// ── Supabase mock: consent ALLOWED (so the gate passes and we reach the
// compliance filter), and a no-op events insert for the compliance_block row.
function createConsentingSupabase() {
  const lead = {
    id: 'lead-1',
    organization_id: 'org-1',
    sms_consent: true,
    sms_opt_out: false,
    email_consent: true,
    email_opt_out: false,
    voice_consent: true,
    voice_opt_out: false,
    do_not_call: false,
  }
  const leadChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: lead, error: null }),
  }
  const eventsChain = { insert: vi.fn().mockResolvedValue({ error: null }) }
  return {
    from: vi.fn((table: string) => (table === 'events' ? eventsChain : leadChain)),
  }
}

describe('FIX 2 — compliance gate blocks forbidden content on AI sends (blockOnReview)', () => {
  it('blocks a forbidden medical claim from SMS send', async () => {
    const supabase = createConsentingSupabase()
    const result = await sendSMSToLead({
      supabase: supabase as never,
      leadId: 'lead-1',
      to: '+15555550123',
      body: 'Our implants are guaranteed to cure your tooth loss — 100% safe!',
      caller: 'test',
      aiGenerated: true,
      blockOnReview: true,
    })

    expect(result.sent).toBe(false)
    if (!result.sent) {
      // Forbidden medical claims are now an ABSOLUTE block (compliance_blocked),
      // not a soft review flag — they can never be sent regardless of caller.
      expect(result.reason).toBe('compliance_blocked')
    }
  })

  it('blocks a forbidden medical claim even without blockOnReview (absolute)', async () => {
    const supabase = createConsentingSupabase()
    const result = await sendSMSToLead({
      supabase: supabase as never,
      leadId: 'lead-1',
      to: '+15555550123',
      body: 'This is a miracle cure — guaranteed results!',
      caller: 'test',
      aiGenerated: true,
      // NOTE: blockOnReview intentionally omitted — forbidden claims must still block.
    })
    expect(result.sent).toBe(false)
    if (!result.sent) {
      expect(result.reason).toBe('compliance_blocked')
    }
  })

  it('blocks a specific price quote from email send', async () => {
    const supabase = createConsentingSupabase()
    const result = await sendEmailToLead({
      supabase: supabase as never,
      leadId: 'lead-1',
      to: 'patient@example.com',
      subject: 'Your treatment plan',
      text: 'Great news — your full-arch treatment is only $40,000 for both arches.',
      html: '<p>...</p>',
      caller: 'test',
      aiGenerated: true,
      blockOnReview: true,
    })

    expect(result.sent).toBe(false)
    if (!result.sent) {
      expect(result.reason).toBe('compliance_review_required')
    }
  })
})

describe('FIX 1 — quiet hours evaluated in org local timezone', () => {
  it('an 11pm-Eastern instant is hour 23 local even though UTC is a different hour', () => {
    // 2026-06-04 03:00 UTC === 2026-06-03 23:00 America/New_York (EDT, UTC-4).
    const instant = new Date('2026-06-04T03:00:00Z')
    const { hour } = getLocalHourAndDay('America/New_York', instant)

    expect(hour).toBe(23)

    // 8-21 active window => 23 is OUTSIDE quiet-hours-compliant sending.
    const activeStart = 8
    const activeEnd = 21
    const insideWindow = hour >= activeStart && hour < activeEnd
    expect(insideWindow).toBe(false)

    // Sanity: the UTC hour would have WRONGLY been 3am (inside a naive check
    // if someone mis-read it), demonstrating why UTC is unsafe here.
    expect(instant.getUTCHours()).toBe(3)
  })

  it('maps weekday correctly for the local timezone (0=Sunday..6=Saturday)', () => {
    // 2026-06-04T03:00:00Z is still Wednesday June 3 in Eastern (day=3).
    const instant = new Date('2026-06-04T03:00:00Z')
    const { day } = getLocalHourAndDay('America/New_York', instant)
    expect(day).toBe(3)
  })

  it('falls back to Eastern on an invalid timezone without throwing', () => {
    const instant = new Date('2026-06-04T03:00:00Z')
    expect(() => getLocalHourAndDay('Not/AReal_Zone', instant)).not.toThrow()
    const { hour } = getLocalHourAndDay('Not/AReal_Zone', instant)
    expect(hour).toBe(23)
  })
})

describe('FIX 4 — stop-word whole-word boundary matching', () => {
  const stopWords = ['stop', 'unsubscribe', 'opt out', 'opt-out']

  it('does NOT match "cancel" inside "don\'t cancel my appt"', () => {
    // "cancel" is intentionally NOT a configured stop word here, and the
    // boundary matcher must not opt the patient out on unrelated phrasing.
    const result = detectStopWord("don't cancel my appt", stopWords)
    expect(result.detected).toBe(false)
  })

  it('does NOT match "stop" inside "non-stoppable" / substring words', () => {
    const result = detectStopWord('this is unstoppable, keep them coming', stopWords)
    expect(result.detected).toBe(false)
  })

  it('matches a standalone "stop"', () => {
    expect(detectStopWord('STOP', stopWords).detected).toBe(true)
    expect(detectStopWord('please stop messaging me', stopWords).detected).toBe(true)
  })

  it('matches the multi-word phrase "opt out"', () => {
    const result = detectStopWord('I want to opt out now', stopWords)
    expect(result.detected).toBe(true)
    expect(result.word).toBe('opt out')
  })
})

// ── FIX 5 — AI service outage must be distinguishable from a per-message failure.
//
// Incident (2026-07-14/15): the Anthropic account hit its configured monthly
// usage cap, so every agent call threw 400 "You have reached your specified API
// usage limits." processAutoResponse caught it, filed a routine 'agent_failure'
// escalation, and sent the patient NOTHING. Two live inbound texts — including a
// "I can't make it" that should have cancelled an appointment — sat unanswered
// for two days because the escalation looked like every other escalation.
//
// isServiceOutage is what splits "the AI is down for everyone" (urgent + send the
// patient a holding ack) from "this one message tripped something" (routine).
describe('FIX 5 — AI service outage detection', () => {
  function anthropicError(status: number, message: string) {
    // Anthropic.APIError(status, error, message, headers)
    return new Anthropic.APIError(status, { type: 'error', error: { message } }, message, undefined)
  }

  it('treats the real usage-cap 400 that caused the incident as an outage', () => {
    const err = anthropicError(
      400,
      'You have reached your specified API usage limits. You will regain access on 2026-08-01 at 00:00 UTC.'
    )
    expect(isServiceOutage(err)).toBe(true)
  })

  it('treats a depleted credit balance as an outage', () => {
    expect(
      isServiceOutage(anthropicError(400, 'Your credit balance is too low to access the API'))
    ).toBe(true)
  })

  it('treats auth, rate-limit and provider 5xx failures as outages', () => {
    expect(isServiceOutage(anthropicError(401, 'invalid x-api-key'))).toBe(true)
    expect(isServiceOutage(anthropicError(429, 'rate_limit_error'))).toBe(true)
    expect(isServiceOutage(anthropicError(529, 'overloaded_error'))).toBe(true)
  })

  it('does NOT treat an ordinary application error as an outage', () => {
    // A bug in our own context-building is a per-message failure: one thread is
    // affected and a human is already being pulled in. It must stay routine, or
    // an everyday exception would page staff as a systemwide outage.
    expect(isServiceOutage(new TypeError('lead.first_name is undefined'))).toBe(false)
    expect(isServiceOutage(new Error('boom'))).toBe(false)
    expect(isServiceOutage('a string')).toBe(false)
    expect(isServiceOutage(null)).toBe(false)
  })
})
