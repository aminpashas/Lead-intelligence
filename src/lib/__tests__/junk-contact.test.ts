import { describe, it, expect } from 'vitest'
import { isJunkCallerContact } from '@/lib/leads/junk-contact'

const wc = (o: Partial<Parameters<typeof isJunkCallerContact>[0]>) => ({
  source_type: 'whatconverts',
  email: null,
  phone_valid: false as boolean | null,
  ...o,
})

describe('isJunkCallerContact', () => {
  it('flags "City ST" caller-ID location strings regardless of (unreliable) phone validity', () => {
    expect(isJunkCallerContact(wc({ first_name: 'Cleveland', last_name: 'Oh' }))).toBe(true)
    expect(isJunkCallerContact(wc({ first_name: 'Chicago', last_name: 'Il', phone_valid: null }))).toBe(true)
    expect(isJunkCallerContact(wc({ first_name: 'San', last_name: 'Rafael Ca', phone_valid: null }))).toBe(true) // 3-token City Name ST
  })

  it('a VALID phone is the one hard keep — even a City-ST shaped name stays a lead', () => {
    // "Jane Oh" collides with the City-ST shape; a working phone rescues it.
    expect(isJunkCallerContact(wc({ first_name: 'Jane', last_name: 'Oh', phone_valid: true }))).toBe(false)
  })

  it('flags carrier / telco placeholder names even when phone validity is unknown', () => {
    expect(isJunkCallerContact(wc({ first_name: 'Wireless', last_name: 'Caller', phone_valid: null }))).toBe(true)
    expect(isJunkCallerContact(wc({ first_name: 'Unknown', last_name: null, phone_valid: null }))).toBe(true)
    expect(isJunkCallerContact(wc({ first_name: 'Toll', last_name: 'Free' }))).toBe(true)
  })

  it('flags empty names only when unreachable', () => {
    expect(isJunkCallerContact(wc({ first_name: null, last_name: null }))).toBe(true)
    expect(isJunkCallerContact(wc({ first_name: null, last_name: null, phone_valid: true }))).toBe(false)
  })

  it('does NOT flag real-looking names with no reachable contact (keeps them as leads)', () => {
    expect(isJunkCallerContact(wc({ first_name: 'Newman,diane', last_name: null }))).toBe(false)
    expect(isJunkCallerContact(wc({ first_name: 'Tsang,pearl', last_name: null }))).toBe(false)
    expect(isJunkCallerContact(wc({ first_name: 'Colleen', last_name: 'Rouse' }))).toBe(false)
  })

  it('NEVER flags a reachable contact, even with a junk-shaped name', () => {
    expect(isJunkCallerContact(wc({ first_name: 'Cleveland', last_name: 'Oh', email: 'a@b.com' }))).toBe(false)
    expect(isJunkCallerContact(wc({ first_name: 'Cleveland', last_name: 'Oh', phone_valid: true }))).toBe(false)
  })

  it('only applies to call-tracking sources', () => {
    expect(isJunkCallerContact({ source_type: 'gohighlevel', first_name: 'Chicago', last_name: 'Il', phone_valid: false })).toBe(false)
    expect(isJunkCallerContact({ source_type: 'form', first_name: 'Unknown', phone_valid: false })).toBe(false)
  })
})
