import { describe, it, expect } from 'vitest'
import {
  parseMetaLeadFields,
  detectMetaConsent,
  hasContact,
  verifyMetaSignature,
  type MetaFieldDatum,
} from '@/lib/connectors/meta/lead-ads'
import crypto from 'crypto'

const field = (name: string, value: string): MetaFieldDatum => ({ name, values: [value] })

describe('parseMetaLeadFields', () => {
  it('extracts standard fields', () => {
    const p = parseMetaLeadFields([
      field('first_name', 'Jane'),
      field('last_name', 'Doe'),
      field('email', 'jane@example.com'),
      field('phone_number', '+15125551234'),
      field('city', 'Austin'),
      field('zip_code', '78701'),
    ])
    expect(p.firstName).toBe('Jane')
    expect(p.lastName).toBe('Doe')
    expect(p.email).toBe('jane@example.com')
    expect(p.phone).toBe('+15125551234')
    expect(p.city).toBe('Austin')
    expect(p.zip).toBe('78701')
  })

  it('splits full_name when first/last absent', () => {
    const p = parseMetaLeadFields([field('full_name', 'John Q Public'), field('email', 'j@x.com')])
    expect(p.firstName).toBe('John')
    expect(p.lastName).toBe('Q Public')
  })

  it('falls back to a placeholder name but no contact', () => {
    const p = parseMetaLeadFields([field('city', 'Austin')])
    expect(p.firstName).toBe('Meta Lead')
    expect(hasContact(p)).toBe(false)
  })

  it('hasContact true with only a phone', () => {
    expect(hasContact(parseMetaLeadFields([field('phone', '5551234567')]))).toBe(true)
  })
})

describe('detectMetaConsent', () => {
  it('no consent question → nothing granted (stays unknown)', () => {
    expect(detectMetaConsent([field('email', 'a@b.com')])).toEqual({})
  })

  it('generic affirmative consent grants both channels', () => {
    const c = detectMetaConsent([field('i_agree_to_be_contacted', 'I agree')])
    expect(c.sms).toBe(true)
    expect(c.email).toBe(true)
  })

  it('sms-specific consent grants only sms', () => {
    const c = detectMetaConsent([field('sms_marketing_consent', 'Yes')])
    expect(c.sms).toBe(true)
    expect(c.email).toBeUndefined()
  })

  it('a non-affirmative value grants nothing', () => {
    const c = detectMetaConsent([field('marketing_consent', 'No')])
    expect(c).toEqual({})
  })

  it('a consent-shaped field with an unrelated value is ignored', () => {
    // guards against false positives from disclaimer text that isn't affirmative
    const c = detectMetaConsent([field('agree_terms', 'maybe later')])
    expect(c).toEqual({})
  })
})

describe('verifyMetaSignature', () => {
  const secret = 'test-app-secret'
  const body = JSON.stringify({ object: 'page', entry: [] })
  const good = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')

  it('accepts a correct signature', () => {
    expect(verifyMetaSignature(body, good, secret)).toBe(true)
  })
  it('rejects a wrong signature', () => {
    const bad = 'sha256=' + crypto.createHmac('sha256', 'other').update(body).digest('hex')
    expect(verifyMetaSignature(body, bad, secret)).toBe(false)
  })
  it('rejects a missing header', () => {
    expect(verifyMetaSignature(body, null, secret)).toBe(false)
  })
  it('rejects a tampered body', () => {
    expect(verifyMetaSignature(body + ' ', good, secret)).toBe(false)
  })
})
