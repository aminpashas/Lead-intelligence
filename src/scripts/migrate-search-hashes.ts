/**
 * Migration: Rehash all search hashes after SEC-4 HMAC key separation.
 *
 * Background:
 * SEC-4 changed searchHash() from using the raw AES master key to a
 * HKDF-derived key. Existing hashes in the database were computed with
 * the old key and won't match new lookups. This script rehashes all
 * existing values.
 *
 * Affected tables/columns:
 * 1. leads.email_hash      — rehashed from decrypted leads.email
 * 2. leads.phone_hash      — rehashed from decrypted leads.phone or leads.phone_formatted
 * 3. financing_applications.applicant_ssn_hash — rehashed from decrypted SSN in applicant_data_encrypted
 *
 * Usage:
 *   npx tsx src/scripts/migrate-search-hashes.ts
 *
 * Prerequisites:
 *   - ENCRYPTION_KEY env var must be set
 *   - SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set
 *   - Run against the PRODUCTION database (or staging first to verify)
 *
 * Safety:
 *   - Dry-run mode by default (set DRY_RUN=false to apply)
 *   - Processes in batches of 100 to avoid memory pressure
 *   - Logs progress and errors to console
 *   - Idempotent: safe to run multiple times
 */

import { createClient } from '@supabase/supabase-js'
import { searchHash, decryptField } from '@/lib/encryption'

const DRY_RUN = process.env.DRY_RUN !== 'false'
const BATCH_SIZE = 100

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  }
  return createClient(url, key)
}

async function migrateLeadHashes() {
  const supabase = getSupabase()
  console.log('\n━━━ Phase 1: Rehashing leads.email_hash and leads.phone_hash ━━━\n')

  let offset = 0
  let totalProcessed = 0
  let totalUpdated = 0
  let totalErrors = 0

  while (true) {
    // Query leads — only select columns that exist. email_hash/phone_hash
    // may not exist yet if the migration is run before the schema is updated.
    const { data: leads, error } = await supabase
      .from('leads')
      .select('id, email, phone, phone_formatted, email_hash, phone_hash')
      .range(offset, offset + BATCH_SIZE - 1)
      .order('created_at', { ascending: true })

    if (error) {
      console.error('Error fetching leads:', error.message)
      break
    }

    if (!leads || leads.length === 0) break

    for (const lead of leads) {
      totalProcessed++
      const updates: Record<string, string | null> = {}

      // Rehash email
      if (lead.email) {
        const decryptedEmail = decryptField(lead.email)
        if (decryptedEmail) {
          const newHash = searchHash(decryptedEmail)
          if (newHash && newHash !== lead.email_hash) {
            updates.email_hash = newHash
          }
        }
      }

      // Rehash phone (prefer phone_formatted, fall back to phone)
      const phoneSource = lead.phone_formatted || lead.phone
      if (phoneSource) {
        const decryptedPhone = decryptField(phoneSource)
        if (decryptedPhone) {
          const newHash = searchHash(decryptedPhone)
          if (newHash && newHash !== lead.phone_hash) {
            updates.phone_hash = newHash
          }
        }
      }

      if (Object.keys(updates).length > 0) {
        if (DRY_RUN) {
          console.log(`  [DRY RUN] Would update lead ${lead.id}: ${Object.keys(updates).join(', ')}`)
        } else {
          const { error: updateError } = await supabase
            .from('leads')
            .update(updates)
            .eq('id', lead.id)

          if (updateError) {
            console.error(`  ✗ Error updating lead ${lead.id}:`, updateError.message)
            totalErrors++
          } else {
            totalUpdated++
          }
        }
      }
    }

    offset += BATCH_SIZE
    process.stdout.write(`  Processed ${totalProcessed} leads...\r`)
  }

  console.log(`\n  ✓ Leads: ${totalProcessed} processed, ${totalUpdated} updated, ${totalErrors} errors`)
  return { totalProcessed, totalUpdated, totalErrors }
}

async function migrateSSNHashes() {
  const supabase = getSupabase()
  console.log('\n━━━ Phase 2: Rehashing financing_applications.applicant_ssn_hash ━━━\n')

  let offset = 0
  let totalProcessed = 0
  let totalUpdated = 0
  let totalErrors = 0

  while (true) {
    const { data: apps, error } = await supabase
      .from('financing_applications')
      .select('id, applicant_data_encrypted, applicant_ssn_hash')
      .not('applicant_data_encrypted', 'is', null)
      .not('applicant_ssn_hash', 'is', null)
      .range(offset, offset + BATCH_SIZE - 1)
      .order('created_at', { ascending: true })

    if (error) {
      console.error('Error fetching applications:', error.message)
      break
    }

    if (!apps || apps.length === 0) break

    for (const app of apps) {
      totalProcessed++

      try {
        // Decrypt the applicant data blob to extract the SSN
        const decryptedJson = decryptField(app.applicant_data_encrypted)
        if (!decryptedJson) {
          console.warn(`  ⚠ Could not decrypt applicant data for app ${app.id}`)
          continue
        }

        const applicantData = JSON.parse(decryptedJson)
        const ssn = applicantData.ssn

        if (!ssn) {
          continue
        }

        const newHash = searchHash(ssn)
        if (newHash && newHash !== app.applicant_ssn_hash) {
          if (DRY_RUN) {
            console.log(`  [DRY RUN] Would update application ${app.id}: applicant_ssn_hash`)
          } else {
            const { error: updateError } = await supabase
              .from('financing_applications')
              .update({ applicant_ssn_hash: newHash })
              .eq('id', app.id)

            if (updateError) {
              console.error(`  ✗ Error updating application ${app.id}:`, updateError.message)
              totalErrors++
            } else {
              totalUpdated++
            }
          }
        }
      } catch (err) {
        console.error(`  ✗ Error processing application ${app.id}:`, err instanceof Error ? err.message : err)
        totalErrors++
      }
    }

    offset += BATCH_SIZE
    process.stdout.write(`  Processed ${totalProcessed} applications...\r`)
  }

  console.log(`\n  ✓ Applications: ${totalProcessed} processed, ${totalUpdated} updated, ${totalErrors} errors`)
  return { totalProcessed, totalUpdated, totalErrors }
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗')
  console.log('║  SEC-4 HMAC Key Migration: Rehash Search Hashes    ║')
  console.log('╚══════════════════════════════════════════════════════╝')
  console.log()
  console.log(`Mode: ${DRY_RUN ? '🔍 DRY RUN (set DRY_RUN=false to apply)' : '🔴 LIVE — changes will be applied'}`)
  console.log(`Encryption key: ${process.env.ENCRYPTION_KEY ? '✓ Set' : '✗ MISSING'}`)
  console.log()

  if (!process.env.ENCRYPTION_KEY) {
    console.error('ENCRYPTION_KEY is not set. Aborting.')
    process.exit(1)
  }

  const leadResults = await migrateLeadHashes()
  const appResults = await migrateSSNHashes()

  console.log('\n━━━ Summary ━━━')
  console.log(`  Leads:        ${leadResults.totalUpdated}/${leadResults.totalProcessed} updated`)
  console.log(`  Applications: ${appResults.totalUpdated}/${appResults.totalProcessed} updated`)
  console.log(`  Total errors: ${leadResults.totalErrors + appResults.totalErrors}`)
  console.log()

  if (DRY_RUN) {
    console.log('💡 This was a dry run. To apply changes, run:')
    console.log('   DRY_RUN=false npx tsx src/scripts/migrate-search-hashes.ts')
  } else {
    console.log('✅ Migration complete.')
  }
}

main().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
