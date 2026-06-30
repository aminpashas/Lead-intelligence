import { describe, it, expect } from 'vitest'
import { consentRevokeFields, consentGrantFields } from '@/lib/consent/capture'

const NOW = '2026-06-30T12:00:00.000Z'

describe('consentRevokeFields', () => {
  it('sets the hard opt-out flag + timestamp for the given channel only', () => {
    const f = consentRevokeFields(['sms'], NOW)
    expect(f.sms_opt_out).toBe(true)
    expect(f.sms_opt_out_at).toBe(NOW)
    // does not touch other channels
    expect(f.email_opt_out).toBeUndefined()
    expect(f.voice_opt_out).toBeUndefined()
  })

  it('never sets a consent boolean (revoke must not grant)', () => {
    const f = consentRevokeFields(['sms', 'email', 'voice'], NOW)
    expect(f.sms_consent).toBeUndefined()
    expect(f.email_consent).toBeUndefined()
    expect(f.voice_consent).toBeUndefined()
    expect(f.sms_opt_out).toBe(true)
    expect(f.email_opt_out).toBe(true)
    expect(f.voice_opt_out).toBe(true)
  })

  it('is the exact inverse shape of consentGrantFields (no overlapping keys)', () => {
    const grant = consentGrantFields(['sms'], NOW, 'ghl_reply_yes')
    const revoke = consentRevokeFields(['sms'], NOW)
    const overlap = Object.keys(grant).filter((k) => k in revoke)
    expect(overlap).toEqual([])
    // grant carries the source; revoke does not (trigger stamps 'inbound_stop')
    expect(grant.sms_consent).toBe(true)
    expect(grant.sms_consent_source).toBe('ghl_reply_yes')
  })

  it('empty channel list writes nothing', () => {
    expect(consentRevokeFields([], NOW)).toEqual({})
  })
})
