import { describe, it, expect } from 'vitest'
import {
  normalizeCallOutcome,
  parseCallReview,
  detectSystemFindings,
} from '@/lib/voice/post-call-review'

describe('normalizeCallOutcome', () => {
  it('books win over everything else', () => {
    expect(
      normalizeCallOutcome({
        appointmentBooked: true,
        disconnectionReason: 'user_hangup',
        callSuccessful: false,
      })
    ).toBe('appointment_booked')
  })

  it('maps transfer / voicemail / no-answer disconnections', () => {
    expect(normalizeCallOutcome({ disconnectionReason: 'call_transfer' })).toBe('transferred')
    expect(normalizeCallOutcome({ disconnectionReason: 'voicemail_reached' })).toBe('voicemail_left')
    expect(normalizeCallOutcome({ disconnectionReason: 'machine_detected' })).toBe('voicemail_left')
    expect(normalizeCallOutcome({ disconnectionReason: 'dial_no_answer' })).toBe('no_answer')
    expect(normalizeCallOutcome({ disconnectionReason: 'dial_busy' })).toBe('no_answer')
    // legacy plain values used by processCallEnd
    expect(normalizeCallOutcome({ disconnectionReason: 'busy' })).toBe('no_answer')
  })

  it('maps platform errors to technical_failure', () => {
    expect(normalizeCallOutcome({ disconnectionReason: 'dial_failed' })).toBe('technical_failure')
    expect(normalizeCallOutcome({ disconnectionReason: 'error_llm_websocket_open' })).toBe('technical_failure')
    expect(normalizeCallOutcome({ disconnectionReason: 'concurrency_limit_reached' })).toBe('technical_failure')
  })

  it('never emits raw disconnection reasons (the old CHECK-violation bug)', () => {
    const out = normalizeCallOutcome({
      disconnectionReason: 'user_hangup',
      durationSeconds: 90,
      hasTranscript: true,
    })
    expect(out).not.toBe('user_hangup')
  })

  it('uses analysis signals for connected calls', () => {
    expect(
      normalizeCallOutcome({ disconnectionReason: 'user_hangup', callSuccessful: true, durationSeconds: 60, hasTranscript: true })
    ).toBe('interested')
    expect(
      normalizeCallOutcome({ disconnectionReason: 'user_hangup', userSentiment: 'Negative', durationSeconds: 60, hasTranscript: true })
    ).toBe('not_interested')
  })

  it('returns null (Needs Review) only for connected, transcribed, unclassifiable calls', () => {
    expect(
      normalizeCallOutcome({ disconnectionReason: 'user_hangup', durationSeconds: 60, hasTranscript: true })
    ).toBeNull()
    // not connected → no_answer
    expect(normalizeCallOutcome({ durationSeconds: 0, hasTranscript: false })).toBe('no_answer')
    // connected but transcript pipeline broke → technical_failure
    expect(normalizeCallOutcome({ durationSeconds: 45, hasTranscript: false })).toBe('technical_failure')
  })
})

describe('parseCallReview', () => {
  it('parses a well-formed review and drops junk entries', () => {
    const review = parseCallReview(JSON.stringify({
      outcome: 'callback_requested',
      outcome_confidence: 'high',
      issues: [
        { category: 'missed_booking', severity: 'critical', summary: 'Caller asked to book, no slot offered', evidence: 'can I come in Tuesday?', recommended_action: 'Call back today' },
        { bogus: true },
      ],
      technical_findings: [
        { category: 'prompt', severity: 'warning', title: 'Agent loops on pricing', summary: 's', recommendation: 'r', action_plan: ['a', 'b'] },
      ],
    }))
    expect(review).not.toBeNull()
    expect(review!.outcome).toBe('callback_requested')
    expect(review!.issues).toHaveLength(1)
    expect(review!.issues[0].severity).toBe('critical')
    expect(review!.technical_findings[0].action_plan).toEqual(['a', 'b'])
  })

  it('rejects outcomes outside the CHECK vocabulary', () => {
    const review = parseCallReview(JSON.stringify({ outcome: 'user_hangup', issues: [], technical_findings: [] }))
    expect(review!.outcome).toBeNull()
  })

  it('survives prose-wrapped JSON and garbage', () => {
    expect(parseCallReview('Sure! Here you go: {"outcome":"interested","issues":[],"technical_findings":[]} hope that helps')!.outcome).toBe('interested')
    expect(parseCallReview('no json at all')).toBeNull()
  })
})

describe('detectSystemFindings', () => {
  const base = { attributed: true, durationSeconds: 60, hasTranscript: true, retellFetchOk: true }

  it('is silent on a clean call', () => {
    expect(detectSystemFindings({ ...base })).toEqual([])
  })

  it('flags answered calls with empty transcripts', () => {
    const findings = detectSystemFindings({ ...base, hasTranscript: false })
    expect(findings.some((f) => f.fingerprint === 'system:telephony:empty_transcript_answered_call')).toBe(true)
  })

  it('flags unattributed calls and failed Retell fetches', () => {
    const findings = detectSystemFindings({ ...base, attributed: false, retellFetchOk: false })
    const keys = findings.map((f) => f.fingerprint)
    expect(keys).toContain('system:data_gap:unattributed_call')
    expect(keys).toContain('system:integration:retell_fetch_failed')
  })

  it('flags platform-error disconnections with a per-reason fingerprint', () => {
    const findings = detectSystemFindings({ ...base, disconnectionReason: 'dial_failed' })
    expect(findings.some((f) => f.fingerprint === 'system:telephony:disconnect_dial_failed')).toBe(true)
  })
})
