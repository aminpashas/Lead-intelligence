import type { SupabaseClient } from '@supabase/supabase-js'
import { searchHash } from '@/lib/encryption'

export type DedupeRow = {
  email?: string | null
  phone_formatted?: string | null
}

export type ExistingMatch = {
  id: string
  matchedOn: 'email' | 'phone'
}

/**
 * Find existing leads in the org that match any incoming row by email or phone.
 *
 * Uses the `email_hash` / `phone_hash` columns populated by `encryptLeadPII`,
 * so the lookup happens server-side without decrypting.
 *
 * Returns a Map keyed by row index → existing lead match. Rows with no match are absent.
 */
export async function findExistingLeads(
  supabase: SupabaseClient,
  organizationId: string,
  rows: DedupeRow[],
): Promise<Map<number, ExistingMatch>> {
  const emailHashes = new Map<string, number>() // hash → first row index
  const phoneHashes = new Map<string, number>()

  rows.forEach((row, idx) => {
    if (row.email) {
      const h = searchHash(row.email)
      if (h && !emailHashes.has(h)) emailHashes.set(h, idx)
    }
    if (row.phone_formatted) {
      const h = searchHash(row.phone_formatted)
      if (h && !phoneHashes.has(h)) phoneHashes.set(h, idx)
    }
  })

  const allEmailHashes = Array.from(emailHashes.keys())
  const allPhoneHashes = Array.from(phoneHashes.keys())

  if (allEmailHashes.length === 0 && allPhoneHashes.length === 0) {
    return new Map()
  }

  // One round-trip: pull existing leads matching any of the hashes in this batch.
  let query = supabase
    .from('leads')
    .select('id, email_hash, phone_hash')
    .eq('organization_id', organizationId)

  if (allEmailHashes.length > 0 && allPhoneHashes.length > 0) {
    const filter = [
      `email_hash.in.(${allEmailHashes.join(',')})`,
      `phone_hash.in.(${allPhoneHashes.join(',')})`,
    ].join(',')
    query = query.or(filter)
  } else if (allEmailHashes.length > 0) {
    query = query.in('email_hash', allEmailHashes)
  } else {
    query = query.in('phone_hash', allPhoneHashes)
  }

  const { data: existing } = await query

  const matches = new Map<number, ExistingMatch>()
  for (const row of existing || []) {
    if (row.email_hash && emailHashes.has(row.email_hash)) {
      const idx = emailHashes.get(row.email_hash)!
      if (!matches.has(idx)) matches.set(idx, { id: row.id, matchedOn: 'email' })
    }
    if (row.phone_hash && phoneHashes.has(row.phone_hash)) {
      const idx = phoneHashes.get(row.phone_hash)!
      if (!matches.has(idx)) matches.set(idx, { id: row.id, matchedOn: 'phone' })
    }
  }

  return matches
}
