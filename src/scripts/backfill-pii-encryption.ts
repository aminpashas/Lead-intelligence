/**
 * Backfill: encrypt any plaintext PII at rest in the `leads` table.
 *
 * Background:
 * encryptLeadPII() encrypts PII on write, but rows written before encryption
 * shipped (or via any path that skipped it) may still hold PLAINTEXT email /
 * phone / DOB / insurance. decryptField() tolerates plaintext (passthrough), so
 * the mix is invisible at runtime — but it means "encryption at rest" is not
 * actually enforced. This script finds plaintext PII rows and encrypts them.
 *
 * Columns processed (leads): email, phone, phone_formatted, date_of_birth,
 * insurance_provider, insurance_details — plus the email_hash / phone_hash
 * search hashes (recomputed from the PLAINTEXT before encrypting).
 *
 * Usage:
 *   npx tsx src/scripts/backfill-pii-encryption.ts          # DRY RUN (default) — counts only
 *   DRY_RUN=false npx tsx src/scripts/backfill-pii-encryption.ts   # APPLY
 *
 * Prerequisites:
 *   - ENCRYPTION_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY set.
 *   - Run against STAGING first, then production. Take a DB backup before --apply.
 *
 * Safety:
 *   - Dry-run by default; only writes when DRY_RUN=false.
 *   - Idempotent: encryptField() skips already-`enc::`-prefixed values, and we
 *     only touch fields that are currently plaintext.
 *   - Batched (500 rows) to bound memory.
 *
 * NOTE: the EHR `patients` table also holds plaintext PHI (see the Series B EHR
 * audit). It is intentionally NOT handled here — encrypting it requires changing
 * the matcher's read paths too, which must be done as a coordinated change.
 */

import { createClient } from '@supabase/supabase-js'
import { encryptField, searchHash } from '../lib/encryption'

const DRY_RUN = process.env.DRY_RUN !== 'false'
const BATCH = 500
const ENC = 'enc::'

const PLAINTEXT_FIELDS = [
  'email',
  'phone',
  'phone_formatted',
  'date_of_birth',
  'insurance_provider',
  'insurance_details',
] as const

function isPlaintext(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && !v.startsWith(ENC)
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
  if (!process.env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY is required')

  const supabase = createClient(url, key, { auth: { persistSession: false } })

  console.log(`\n${DRY_RUN ? '🔍 DRY RUN' : '✍️  APPLYING'} — backfill PII encryption on leads\n`)

  let from = 0
  let scanned = 0
  let needFix = 0
  let fixed = 0
  const fieldCounts: Record<string, number> = {}

  for (;;) {
    const { data: rows, error } = await supabase
      .from('leads')
      .select('id, email, phone, phone_formatted, date_of_birth, insurance_provider, insurance_details')
      .order('created_at', { ascending: true })
      .range(from, from + BATCH - 1)

    if (error) throw error
    if (!rows || rows.length === 0) break

    for (const row of rows as Record<string, unknown>[]) {
      scanned++
      const updates: Record<string, unknown> = {}

      for (const f of PLAINTEXT_FIELDS) {
        if (isPlaintext(row[f])) {
          updates[f] = encryptField(row[f] as string)
          fieldCounts[f] = (fieldCounts[f] ?? 0) + 1
          // Recompute search hashes from the PLAINTEXT value.
          if (f === 'email') updates.email_hash = searchHash(row[f] as string)
          if (f === 'phone_formatted') updates.phone_hash = searchHash(row[f] as string)
        }
      }
      // If only `phone` (not phone_formatted) was plaintext, still set phone_hash.
      if (isPlaintext(row.phone) && !isPlaintext(row.phone_formatted)) {
        updates.phone_hash = searchHash(row.phone as string)
      }

      if (Object.keys(updates).length === 0) continue
      needFix++

      if (!DRY_RUN) {
        const { error: upErr } = await supabase.from('leads').update(updates).eq('id', row.id as string)
        if (upErr) {
          console.error(`  ✗ lead ${row.id}: ${upErr.message}`)
        } else {
          fixed++
        }
      }
    }

    from += BATCH
    process.stdout.write(`  scanned ${scanned} (plaintext rows: ${needFix})\r`)
  }

  console.log('\n\n── Summary ──')
  console.log(`  scanned:            ${scanned}`)
  console.log(`  rows w/ plaintext:  ${needFix}`)
  console.log(`  per-field plaintext:`, fieldCounts)
  if (DRY_RUN) {
    console.log(`\n  DRY RUN — nothing written. Re-run with DRY_RUN=false to apply.\n`)
  } else {
    console.log(`  rows fixed:         ${fixed}\n`)
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err)
  process.exit(1)
})
