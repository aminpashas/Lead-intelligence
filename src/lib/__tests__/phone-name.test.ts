import { describe, it, expect } from 'vitest'
import { scrubPhoneNames } from '@/lib/leads/phone-name'
import { leadDisplayName, leadInitials } from '@/lib/leads/display-name'

describe('scrubPhoneNames', () => {
  // Every case below is a REAL prod row from SF Dentistry (2026-07 audit).
  it('nulls both columns when a phone number was split across them', () => {
    // The reported bug: lead d367b07b rendered as "Book (925) 497-0821 — ready".
    expect(scrubPhoneNames({ first: '(925)', last: '497-0821' })).toEqual({
      first: null, last: null, changed: true,
    })
    expect(scrubPhoneNames({ first: '-408', last: '724-0003' })).toEqual({
      first: null, last: null, changed: true,
    })
  })

  it('nulls a split pair regardless of digit count — neither half is ever a name', () => {
    // International and fragmentary pairs: no digit floor applies to a split pair.
    expect(scrubPhoneNames({ first: '+52', last: '675 108 4917' }).changed).toBe(true) // 12 digits
    expect(scrubPhoneNames({ first: '6966', last: '8755' }).changed).toBe(true) // 8 digits
    expect(scrubPhoneNames({ first: '90', last: '53 96 44' }).changed).toBe(true) // 8 digits
  })

  it('keeps a real first name and nulls only the stray phone beside it', () => {
    expect(scrubPhoneNames({ first: 'chris', last: '606-2595' })).toEqual({
      first: 'chris', last: null, changed: true,
    })
    expect(scrubPhoneNames({ first: 'dolores', last: '369-3166' })).toEqual({
      first: 'dolores', last: null, changed: true,
    })
  })

  it('keeps a real last name and nulls only the phone in the first column', () => {
    expect(scrubPhoneNames({ first: '5103315182', last: 'boyer' })).toEqual({
      first: null, last: 'boyer', changed: true,
    })
  })

  it('LEAVES short numbers that are part of a real name — a false positive is unrecoverable', () => {
    // These are the rows a blanket "looks numeric → null" rule would have eaten.
    expect(scrubPhoneNames({ first: 'Booth', last: '14' }).changed).toBe(false)
    expect(scrubPhoneNames({ first: '101', last: 'California' }).changed).toBe(false)
    expect(scrubPhoneNames({ first: 'Elias', last: '111' }).changed).toBe(false)
    expect(scrubPhoneNames({ first: 'Ns', last: '113107' }).changed).toBe(false) // 6 digits < floor
    expect(scrubPhoneNames({ first: 'Design', last: '2020' }).changed).toBe(false)
  })

  it('leaves ordinary names untouched', () => {
    expect(scrubPhoneNames({ first: 'Ada', last: 'Lovelace' })).toEqual({
      first: 'Ada', last: 'Lovelace', changed: false,
    })
    expect(scrubPhoneNames({ first: 'Cher', last: null })).toEqual({
      first: 'Cher', last: null, changed: false,
    })
  })

  it('normalizes blanks to null without claiming a change', () => {
    expect(scrubPhoneNames({ first: '', last: '  ' })).toEqual({
      first: null, last: null, changed: false,
    })
  })

  it('does not treat a token containing letters as a phone number', () => {
    // "682-audry" is mangled, but it holds a name — leave it for a human.
    expect(scrubPhoneNames({ first: '-510', last: '682-audry' }).changed).toBe(false)
  })
})

describe('leadDisplayName', () => {
  it('prefers a real name', () => {
    expect(leadDisplayName({ first_name: 'Ada', last_name: 'Lovelace' })).toBe('Ada Lovelace')
    expect(leadDisplayName({ first_name: 'Cher', last_name: null })).toBe('Cher')
  })

  it('falls back to the phone once a scrubbed lead has no name — never blank', () => {
    expect(leadDisplayName({
      first_name: null, last_name: null, phone_formatted: '+19254970821',
    })).toBe('+19254970821')
  })

  it("treats '' exactly like null — the NOT NULL first_name column stores '' for no-name", () => {
    expect(leadDisplayName({
      first_name: '', last_name: null, phone_formatted: '+19254970821',
    })).toBe('+19254970821')
    expect(leadDisplayName({ first_name: '', last_name: null })).toBe('Unknown')
  })

  it('falls back to "Unknown" with neither name nor phone', () => {
    expect(leadDisplayName({ first_name: null, last_name: null })).toBe('Unknown')
    expect(leadDisplayName(null)).toBe('Unknown')
    expect(leadDisplayName(null, 'Unknown patient')).toBe('Unknown patient')
  })

  it('never surfaces an encryption envelope as a name', () => {
    // A server page that forgot to decrypt must not render "enc::AbC…".
    expect(leadDisplayName({
      first_name: 'enc::AbC123', last_name: null, phone: 'enc::XyZ789',
    })).toBe('Unknown')
  })
})

describe('leadInitials', () => {
  it('derives initials from a real name', () => {
    expect(leadInitials({ first_name: 'Ada', last_name: 'Lovelace' })).toBe('AL')
  })

  it('yields no initials for a nameless lead rather than punctuation garbage', () => {
    // Pre-fix this rendered "(4" for first_name="(925)", last_name="497-0821".
    expect(leadInitials({ first_name: null, last_name: null })).toBe('')
    expect(leadInitials({ first_name: '(925)', last_name: '497-0821' })).toBe('')
  })
})
