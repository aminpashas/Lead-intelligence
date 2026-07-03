import { describe, it, expect } from 'vitest'
import { resolveImportConsent } from '@/lib/leads/import-consent'

const NOW = '2026-07-02T12:00:00.000Z'
const defaults = { sms: false, email: false, voice: false, source: 'ghl_export', attested_at: NOW }

describe('resolveImportConsent', () => {
  it('grants a channel when the row opts in, stamping ts + source', () => {
    const r = resolveImportConsent(
      { sms_consent: true, sms_consent_at: '2025-01-01T00:00:00Z', sms_consent_source: 'ghl_optin' },
      defaults,
    )
    expect(r.sms_consent).toBe(true)
    expect(r.sms_opt_out).toBe(false)
    expect(r.sms_consent_at).toBe('2025-01-01T00:00:00Z')
    expect(r.sms_consent_source).toBe('ghl_optin')
  })

  it('falls back to the wrapper attestation ts/source when the row omits them', () => {
    const r = resolveImportConsent({ sms_consent: true }, defaults)
    expect(r.sms_consent_at).toBe(NOW)
    expect(r.sms_consent_source).toBe('ghl_export')
  })

  it('OPT-OUT WINS: a per-channel opt-out forces consent off even if consent=true in the same row', () => {
    const r = resolveImportConsent({ sms_consent: true, sms_opt_out: true }, defaults)
    expect(r.sms_consent).toBe(false)
    expect(r.sms_opt_out).toBe(true)
    expect(r.sms_consent_at).toBeNull()
    expect(r.sms_consent_source).toBeNull()
  })

  it('do_not_contact suppresses ALL channels regardless of consent', () => {
    const r = resolveImportConsent(
      { sms_consent: true, email_consent: true, voice_consent: true, do_not_contact: true },
      defaults,
    )
    expect(r.sms_consent).toBe(false)
    expect(r.email_consent).toBe(false)
    expect(r.voice_consent).toBe(false)
    expect(r.sms_opt_out).toBe(true)
    expect(r.email_opt_out).toBe(true)
    expect(r.do_not_call).toBe(true)
  })

  it('email opt-out does not affect sms consent', () => {
    const r = resolveImportConsent({ sms_consent: true, email_consent: true, email_opt_out: true }, defaults)
    expect(r.sms_consent).toBe(true)
    expect(r.email_consent).toBe(false)
    expect(r.email_opt_out).toBe(true)
    expect(r.sms_opt_out).toBe(false)
  })

  it('no signal → unknown/false everywhere, no fabricated opt-out', () => {
    const r = resolveImportConsent({}, defaults)
    expect(r.sms_consent).toBe(false)
    expect(r.sms_opt_out).toBe(false)
    expect(r.email_opt_out).toBe(false)
    expect(r.do_not_call).toBe(false)
    expect(r.sms_consent_at).toBeNull()
  })
})
