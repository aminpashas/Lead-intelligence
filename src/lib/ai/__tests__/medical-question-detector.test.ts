import { describe, it, expect } from 'vitest'
import {
  keywordScreen,
  severityToPriority,
  parseClassifierResponse,
} from '@/lib/ai/medical-question-detector'

describe('keywordScreen — fail-safe clinical detection', () => {
  it.each([
    'The swelling on my face is spreading and getting worse',
    "My gum won't stop bleeding since last night",
    'I think it might be infected, there is pus around the implant',
    'I have a fever and the pain is unbearable',
    'I am having an allergic reaction, my throat feels like it is closing',
  ])('flags URGENT: %s', (msg) => {
    const r = keywordScreen(msg)
    expect(r.isClinicalQuestion).toBe(true)
    expect(r.severity).toBe('urgent')
  })

  it.each([
    'Should I stop my blood thinner before the surgery?',
    'Is 33 sessions of radiation going to affect my implant timeline?',
    'What are the side effects of this treatment?',
    'Do I have an infection or is this normal healing?',
    'My oncologist mentioned my tonsil — does that change anything for implants?',
  ])('flags ELEVATED clinical question: %s', (msg) => {
    const r = keywordScreen(msg)
    expect(r.isClinicalQuestion).toBe(true)
    expect(r.severity).toBe('elevated')
  })

  it.each([
    'What time is my appointment tomorrow?',
    'Can I reschedule to next week?',
    'How much does the full-arch cost with financing?',
    'Thanks, that works for me!',
    'Do you have parking at the office?',
  ])('does NOT flag non-clinical logistics: %s', (msg) => {
    const r = keywordScreen(msg)
    expect(r.isClinicalQuestion).toBe(false)
    expect(r.severity).toBe('routine')
  })

  it('urgent takes precedence over general clinical language', () => {
    const r = keywordScreen('I have a fever and a question about my medication')
    expect(r.severity).toBe('urgent')
  })
})

describe('severityToPriority', () => {
  it('maps severity to escalation priority', () => {
    expect(severityToPriority('urgent')).toBe('urgent')
    expect(severityToPriority('elevated')).toBe('high')
    expect(severityToPriority('routine')).toBe('normal')
  })
})

describe('parseClassifierResponse', () => {
  it('parses a well-formed clinical classification', () => {
    const r = parseClassifierResponse(
      JSON.stringify({
        isClinicalQuestion: true,
        severity: 'urgent',
        categories: ['symptom', 'post_op'],
        rationale: 'Reports spreading swelling after surgery.',
        confidence: 0.92,
      })
    )
    expect(r.isClinicalQuestion).toBe(true)
    expect(r.severity).toBe('urgent')
    expect(r.categories).toEqual(['symptom', 'post_op'])
    expect(r.method).toBe('classifier')
    expect(r.confidence).toBeCloseTo(0.92)
  })

  it('tolerates prose around the JSON object', () => {
    const r = parseClassifierResponse(
      'Here is the classification:\n{"isClinicalQuestion": false, "severity": "routine", "categories": [], "rationale": "Scheduling only.", "confidence": 0.8}\nDone.'
    )
    expect(r.isClinicalQuestion).toBe(false)
  })

  it('upgrades a clinical question wrongly labelled routine to elevated', () => {
    const r = parseClassifierResponse(
      '{"isClinicalQuestion": true, "severity": "routine", "categories": ["medication"], "rationale": "x", "confidence": 0.7}'
    )
    expect(r.severity).toBe('elevated')
  })

  it('forces non-clinical results to routine severity', () => {
    const r = parseClassifierResponse(
      '{"isClinicalQuestion": false, "severity": "urgent", "categories": [], "rationale": "x", "confidence": 0.7}'
    )
    expect(r.severity).toBe('routine')
  })

  it('clamps out-of-range confidence and defaults invalid severity', () => {
    const r = parseClassifierResponse(
      '{"isClinicalQuestion": true, "severity": "bogus", "categories": ["medication"], "confidence": 5}'
    )
    expect(r.confidence).toBeLessThanOrEqual(1)
    expect(['routine', 'elevated', 'urgent']).toContain(r.severity)
  })

  it('throws on output with no JSON so the caller can fall back', () => {
    expect(() => parseClassifierResponse('I could not classify this.')).toThrow()
  })
})
