import { describe, it, expect } from 'vitest'
import {
  consentCaptureBudget,
  consentCaptureSendEnabled,
  CONSENT_CAPTURE_CHANNELS,
  CONSENT_CAPTURE_REPERMISSION_TAG,
  CONSENT_CAPTURE_DEFAULT_DAILY_CAP,
} from '@/lib/consent/campaign'

describe('consentCaptureBudget', () => {
  it('is the daily cap minus what already went out today, floored at 0', () => {
    expect(consentCaptureBudget(250, 0)).toBe(250)
    expect(consentCaptureBudget(250, 100)).toBe(150)
    expect(consentCaptureBudget(250, 250)).toBe(0)
    expect(consentCaptureBudget(250, 400)).toBe(0)
  })
  it('clamps negative / fractional inputs', () => {
    expect(consentCaptureBudget(250, -5)).toBe(250)
    expect(consentCaptureBudget(250.9, 0.4)).toBe(250)
  })
})

describe('consentCaptureSendEnabled (master send switch)', () => {
  it('is true only for the exact string "true" — anything else dry-runs', () => {
    expect(consentCaptureSendEnabled({ CONSENT_CAPTURE_SEND: 'true' })).toBe(true)
    expect(consentCaptureSendEnabled({ CONSENT_CAPTURE_SEND: 'false' })).toBe(false)
    expect(consentCaptureSendEnabled({ CONSENT_CAPTURE_SEND: '1' })).toBe(false)
    expect(consentCaptureSendEnabled({ CONSENT_CAPTURE_SEND: 'TRUE' })).toBe(false)
    expect(consentCaptureSendEnabled({})).toBe(false)
    expect(consentCaptureSendEnabled({ CONSENT_CAPTURE_SEND: undefined })).toBe(false)
  })
})

describe('re-permission config', () => {
  it('captures all three channels so one opt-in unlocks email + SMS + AI-voice', () => {
    expect(CONSENT_CAPTURE_CHANNELS).toEqual(['email', 'sms', 'voice'])
  })
  it('targets the full-arch cold tag and a conservative warmup cap by default', () => {
    expect(CONSENT_CAPTURE_REPERMISSION_TAG).toBe('full-arch-cold')
    expect(CONSENT_CAPTURE_DEFAULT_DAILY_CAP).toBe(250)
  })
})
