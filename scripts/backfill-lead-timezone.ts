/**
 * Backfill leads.timezone from each lead's phone area code.
 *
 * WHY: leads.timezone is currently a uniform default ('America/New_York' for the
 * whole cold pool) — useless for per-recipient TCPA quiet hours. This derives a
 * real IANA timezone from the NANP area code using the SAME map as the database
 * (public.nanp_area_code_timezones), fetched once so there is a single source of
 * truth (no drift between SQL and TS).
 *
 * PII-SAFE: phone numbers are decrypted ONLY in this process. Only {id, timezone}
 * is ever written back — plaintext phone numbers never appear in a DB query, so
 * they can't leak into query logs.
 *
 * IDEMPOTENT + RESUMABLE: re-running derives the same value and only writes rows
 * whose stored timezone differs from the derived one. Keyset pagination by id.
 *
 * Usage:
 *   DRY_RUN=1 npx tsx scripts/backfill-lead-timezone.ts     # report only, no writes
 *   npx tsx scripts/backfill-lead-timezone.ts               # apply
 *
 * Env (from .env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ENCRYPTION_KEY
 * Optional: LI_ORG_ID (default Dion Health SF), BATCH (default 1000), LIMIT (cap rows, for testing)
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
config() // fallback to .env if present

import { createClient } from '@supabase/supabase-js'
import { decryptField } from '../src/lib/encryption'

function reqEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`❌ Missing required env: ${name}`)
    process.exit(1)
  }
  return v
}

const ORG_ID = process.env.LI_ORG_ID || 'fa64e53c-3d9b-493e-b904-59580cb3f29c' // Dion Health SF
const BATCH = Math.max(100, Math.min(2000, parseInt(process.env.BATCH || '1000') || 1000))
// Harden LIMIT: a non-numeric value must NOT silently disable the cap (NaN compares
// false forever → a full run). Fall back to Infinity only on a genuinely absent/invalid value.
const _limitN = parseInt(process.env.LIMIT ?? '')
const LIMIT = Number.isFinite(_limitN) ? _limitN : Infinity
const UPDATE_CHUNK = 300 // ids per UPDATE ... in (...) statement
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true'

const supabase = createClient(reqEnv('NEXT_PUBLIC_SUPABASE_URL'), reqEnv('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
})
reqEnv('ENCRYPTION_KEY') // fail fast if decryption can't work

/** Mirror of the SQL phone_area_code_timezone() extraction: NANP 10/11-digit → area code. */
function areaCode(e164: string | null | undefined): string | null {
  if (!e164) return null
  const d = e164.replace(/\D/g, '')
  if (d.length === 11 && d[0] === '1') return d.slice(1, 4)
  if (d.length === 10) return d.slice(0, 3)
  return null
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

async function main() {
  console.log(`\n🕓 leads.timezone backfill — org ${ORG_ID}  ${DRY_RUN ? '(DRY RUN — no writes)' : '(APPLYING)'}\n${'─'.repeat(64)}`)

  // 1) Single source of truth: pull the area-code → tz map from the DB.
  const { data: tzRows, error: tzErr } = await supabase
    .from('nanp_area_code_timezones')
    .select('area_code, timezone')
  if (tzErr || !tzRows?.length) {
    console.error('❌ Could not load nanp_area_code_timezones (is the migration applied?):', tzErr?.message)
    process.exit(1)
  }
  const tzMap = new Map<string, string>(tzRows.map((r) => [r.area_code as string, r.timezone as string]))
  console.log(`Loaded ${tzMap.size} area-code → timezone mappings.`)

  const stats = { scanned: 0, derived: 0, updated: 0, unchanged: 0, underivable: 0, decryptErrors: 0 }
  const sampleChanges: string[] = []

  // 2) Keyset-paginate leads with a phone; derive; group changes by tz; update.
  let lastId = '00000000-0000-0000-0000-000000000000'
  for (;;) {
    if (stats.scanned >= LIMIT) break
    const { data: leads, error } = await supabase
      .from('leads')
      .select('id, phone_formatted, phone, timezone')
      .eq('organization_id', ORG_ID)
      .or('phone_formatted.not.is.null,phone.not.is.null')
      .gt('id', lastId)
      .order('id', { ascending: true })
      .limit(BATCH)
    if (error) {
      console.error('❌ Fetch error:', error.message)
      process.exit(1)
    }
    if (!leads?.length) break

    const changesByTz = new Map<string, string[]>()
    for (const lead of leads) {
      stats.scanned++
      lastId = lead.id as string
      let e164: string | null = null
      try {
        e164 = decryptField(lead.phone_formatted as string) || decryptField(lead.phone as string)
      } catch {
        stats.decryptErrors++
        continue
      }
      const ac = areaCode(e164)
      const tz = ac ? tzMap.get(ac) ?? null : null
      if (!tz) {
        stats.underivable++
        continue
      }
      stats.derived++
      if (tz === lead.timezone) {
        stats.unchanged++
        continue
      }
      if (sampleChanges.length < 8) sampleChanges.push(`${lead.timezone} → ${tz}  (area ${ac})`)
      if (!changesByTz.has(tz)) changesByTz.set(tz, [])
      changesByTz.get(tz)!.push(lead.id as string)
    }

    // 3) Apply per-tz, in chunked UPDATEs (skip in dry-run).
    if (!DRY_RUN) {
      for (const [tz, ids] of changesByTz) {
        for (const ids300 of chunk(ids, UPDATE_CHUNK)) {
          const { error: upErr, count } = await supabase
            .from('leads')
            .update({ timezone: tz }, { count: 'exact' })
            .eq('organization_id', ORG_ID)
            .in('id', ids300)
            .neq('timezone', tz) // idempotent: only rows not already correct
          if (upErr) {
            console.error(`❌ Update error (tz=${tz}):`, upErr.message)
            process.exit(1)
          }
          stats.updated += count ?? ids300.length
        }
      }
    } else {
      for (const ids of changesByTz.values()) stats.updated += ids.length
    }

    process.stdout.write(`\r  scanned ${stats.scanned}  derived ${stats.derived}  ${DRY_RUN ? 'would-update' : 'updated'} ${stats.updated}  underivable ${stats.underivable}   `)
    if (leads.length < BATCH) break
  }

  console.log(`\n${'─'.repeat(64)}`)
  console.log(`Scanned:        ${stats.scanned}`)
  console.log(`Derived a tz:   ${stats.derived}`)
  console.log(`${DRY_RUN ? 'Would update:  ' : 'Updated:       '} ${stats.updated}`)
  console.log(`Already correct:${stats.unchanged}`)
  console.log(`Underivable:    ${stats.underivable}  (unknown/invalid area code — left as-is; send-gate uses the conservative fallback)`)
  console.log(`Decrypt errors: ${stats.decryptErrors}`)
  if (sampleChanges.length) {
    console.log(`\nSample changes:`)
    for (const s of sampleChanges) console.log(`  ${s}`)
  }
  console.log(DRY_RUN ? `\n(DRY RUN — nothing written. Re-run without DRY_RUN=1 to apply.)` : `\n✅ Backfill complete.`)
}

main().catch((e) => {
  console.error('❌ Fatal:', e)
  process.exit(1)
})
