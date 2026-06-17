import { describe, it, expect } from 'vitest'
import { deriveConsentFields, statusFromInput } from '@/lib/consent/ingest'

const NOW = '2026-06-17T12:00:00.000Z'

describe('statusFromInput', () => {
  it('true → granted', () => expect(statusFromInput(true)).toBe('granted'))
  it('false → declined', () => expect(statusFromInput(false)).toBe('declined'))
  it('undefined → unknown', () => expect(statusFromInput(undefined)).toBe('unknown'))
})

describe('deriveConsentFields', () => {
  it('omitted fields map to unknown and write no boolean/stamp', () => {
    const f = deriveConsentFields({ now: NOW })
    expect(f.sms_consent_status).toBe('unknown')
    expect(f.email_consent_status).toBe('unknown')
    expect(f.voice_consent_status).toBe('unknown')
    // never fabricate a boolean for the gate
    expect(f.sms_consent).toBeUndefined()
    expect(f.voice_consent).toBeUndefined()
    expect(f.sms_consent_at).toBeUndefined()
  })

  it('explicit false → declined, but no boolean written (gate stays blocked)', () => {
    const f = deriveConsentFields({ sms_consent: false, now: NOW })
    expect(f.sms_consent_status).toBe('declined')
    expect(f.sms_consent).toBeUndefined()
    expect(f.sms_consent_at).toBeUndefined()
  })

  it('explicit true → granted with boolean, stamp, and source', () => {
    const f = deriveConsentFields({ sms_consent: true, consent_source: 'dgs_form', now: NOW })
    expect(f.sms_consent_status).toBe('granted')
    expect(f.sms_consent).toBe(true)
    expect(f.sms_consent_at).toBe(NOW)
    expect(f.sms_consent_source).toBe('dgs_form')
  })

  it('defaults source to dgs_bridge when not provided', () => {
    const f = deriveConsentFields({ voice_consent: true, now: NOW })
    expect(f.voice_consent_source).toBe('dgs_bridge')
    expect(f.voice_consent).toBe(true)
    expect(f.voice_consent_at).toBe(NOW)
  })

  it('handles mixed channels independently', () => {
    const f = deriveConsentFields({
      sms_consent: true,
      email_consent: false,
      // voice omitted
      consent_source: 'ghl_import',
      now: NOW,
    })
    expect(f.sms_consent_status).toBe('granted')
    expect(f.sms_consent).toBe(true)
    expect(f.email_consent_status).toBe('declined')
    expect(f.email_consent).toBeUndefined()
    expect(f.voice_consent_status).toBe('unknown')
  })
})
