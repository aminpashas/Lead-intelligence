/**
 * Manual contact entry — staff typing a phone/email onto a lead.
 *
 * The invariant that matters here is hash parity: a number typed by hand must
 * produce the SAME phone_hash as the same number arriving through ingest, or
 * inbound dedup silently stops matching that lead. That failure is invisible in
 * the UI (the number displays fine) and only shows up as messages landing on the
 * wrong thread weeks later, so it's pinned down here.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { formatToE164 } from '@/lib/leads/phone'
import { searchHash } from '@/lib/encryption'

// encryption.ts reads ENCRYPTION_KEY lazily on first use, so setting it here is
// enough. Any valid 64-char hex key works — these tests assert that two inputs
// hash to the SAME value, never that they equal a specific digest.
beforeAll(() => {
  process.env.ENCRYPTION_KEY ??= 'a'.repeat(64)
})

describe('formatToE164 — staff-typed phone shapes', () => {
  it('normalizes the formats a person actually types', () => {
    const e164 = '+15624465110'
    expect(formatToE164('562-446-5110')).toBe(e164)
    expect(formatToE164('(562) 446-5110')).toBe(e164)
    expect(formatToE164('5624465110')).toBe(e164)
    expect(formatToE164('+1 562 446 5110')).toBe(e164)
    expect(formatToE164('1-562-446-5110')).toBe(e164)
  })

  it('rejects input that cannot be a real number, rather than guessing', () => {
    expect(formatToE164('555-1212')).toBeNull()      // too few digits
    expect(formatToE164('1234567890123456')).toBeNull() // too many
    expect(formatToE164('')).toBeNull()
    expect(formatToE164(null)).toBeNull()
  })
})

describe('hash parity between manual entry and ingest', () => {
  it('hashes a hand-typed number identically to an ingested one', () => {
    // What ingest stores: already-normalized E.164.
    const ingested = searchHash(formatToE164('+15624465110'))
    // What a staff member types into the lead header.
    const typed = searchHash(formatToE164('(562) 446-5110'))

    expect(typed).toBe(ingested)
    expect(typed).not.toBeNull()
  })

  it('would NOT match if the raw string were hashed instead of the E.164 form', () => {
    // This is the regression the PATCH route's normalization exists to prevent:
    // encryptLeadPII falls back to hashing raw `phone` when phone_formatted is
    // absent, which yields a hash nothing else in the system can find.
    const rawHash = searchHash('(562) 446-5110')
    const e164Hash = searchHash('+15624465110')
    expect(rawHash).not.toBe(e164Hash)
  })

  it('normalizes email case so a hand-typed address matches an ingested one', () => {
    expect(searchHash('ElaineLBallard@iCloud.com')).toBe(searchHash('elainelballard@icloud.com'))
  })
})
