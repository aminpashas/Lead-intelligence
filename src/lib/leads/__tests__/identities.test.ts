import { describe, it, expect } from 'vitest'
import { normalizeIdentities, type LeadIdentity } from '@/lib/leads/identities'
import {
  normalizeName,
  pickNameMatch,
  type NameMatchCandidate,
} from '@/lib/leads/social-name-match'

describe('normalizeIdentities', () => {
  it('keeps well-formed identities as-is', () => {
    const input: LeadIdentity[] = [
      { kind: 'meta_psid', value: '24601' },
      { kind: 'ghl_contact_id', value: '5xXGD5HPC21rGhQux71D' },
    ]
    expect(normalizeIdentities(input)).toEqual(input)
  })

  it('drops empty and whitespace-only values', () => {
    // An empty id must never be stored: it would become a key that every other
    // contactless lead matches on, merging unrelated people.
    expect(
      normalizeIdentities([
        { kind: 'meta_psid', value: '' },
        { kind: 'ghl_contact_id', value: '   ' },
        { kind: 'dgs_lead_id', value: 'abc' },
      ]),
    ).toEqual([{ kind: 'dgs_lead_id', value: 'abc' }])
  })

  it('trims surrounding whitespace so a padded id matches a clean one', () => {
    expect(normalizeIdentities([{ kind: 'meta_psid', value: '  24601 ' }])).toEqual([
      { kind: 'meta_psid', value: '24601' },
    ])
  })

  it('dedups repeats of the same kind+value', () => {
    expect(
      normalizeIdentities([
        { kind: 'meta_psid', value: '24601' },
        { kind: 'meta_psid', value: '24601' },
      ]),
    ).toEqual([{ kind: 'meta_psid', value: '24601' }])
  })

  it('treats the same value under different kinds as distinct', () => {
    // Namespaces are independent — a PSID and a GHL id could collide as strings
    // without referring to the same person.
    const input: LeadIdentity[] = [
      { kind: 'meta_psid', value: 'X1' },
      { kind: 'ghl_contact_id', value: 'X1' },
    ]
    expect(normalizeIdentities(input)).toHaveLength(2)
  })

  it('returns empty for undefined / empty input', () => {
    expect(normalizeIdentities(undefined)).toEqual([])
    expect(normalizeIdentities([])).toEqual([])
  })
})

describe('normalizeName', () => {
  it('casefolds, strips punctuation and collapses whitespace', () => {
    // "Barbara J. Haffner" from Meta vs "barbara j haffner" in the DB.
    expect(normalizeName('Barbara', 'J. Haffner')).toBe('barbara j haffner')
    expect(normalizeName('  ELLEN ', 'Dela   Vega')).toBe('ellen dela vega')
  })

  it('tolerates a missing last name', () => {
    expect(normalizeName('Alex', null)).toBe('alex')
  })
})

describe('pickNameMatch', () => {
  const shell = (id: string): NameMatchCandidate => ({
    id,
    first_name: 'Tara',
    last_name: 'Nguyen',
    hasContactInfo: false,
    ageDays: 2,
  })

  it('attaches to a single contactless shell', () => {
    // The real 2026-07-20 case: a DGS shell and a GHL Messenger row for the
    // same person, neither carrying a phone or email.
    expect(pickNameMatch('tara nguyen', [shell('lead-1')])).toBe('lead-1')
  })

  it('refuses a single-token name', () => {
    // "Alex" alone is far too weak to merge two people on.
    expect(pickNameMatch('alex', [{ ...shell('lead-1'), last_name: null }])).toBeNull()
  })

  it('refuses when more than one candidate shares the name', () => {
    // Ambiguity is evidence the name is too common to trust at all.
    expect(pickNameMatch('tara nguyen', [shell('lead-1'), shell('lead-2')])).toBeNull()
  })

  it('refuses a candidate that has contact info', () => {
    // The dangerous merge: attaching a stranger's DM to a real patient record
    // is worse and less detectable than leaving a duplicate.
    expect(
      pickNameMatch('tara nguyen', [{ ...shell('lead-1'), hasContactInfo: true }]),
    ).toBeNull()
  })

  it('refuses when there are no candidates', () => {
    expect(pickNameMatch('tara nguyen', [])).toBeNull()
  })
})
