/**
 * Apply ONLY the 2 booking-EHR migrations via the Supabase Management API
 * database/query endpoint (== running them in the SQL Editor). No db push, no
 * over-apply. Token is passed in via SB_TOKEN env (never printed).
 *   SB_TOKEN=$(security find-generic-password -s "Supabase CLI" -w) npx tsx scripts/apply-migrations-via-api.ts
 */
import { readFileSync } from 'node:fs'

const token = process.env.SB_TOKEN
if (!token) { console.error('SB_TOKEN not set'); process.exit(1) }
const ref = readFileSync('supabase/.temp/project-ref', 'utf8').trim()
const FILES = [
  'supabase/migrations/20260701_ehr_appointment_sync.sql',
  'supabase/migrations/20260701_ehr_busy_slots.sql',
]

async function query(sql: string): Promise<string> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 500)}`)
  return text
}

async function main() {
  console.log(`Project ${ref} — applying via Management API...\n`)
  for (const f of FILES) {
    process.stdout.write(`  ${f} ... `)
    await query(readFileSync(f, 'utf8'))
    console.log('✓')
  }
  const verify = await query(`select json_build_object(
    'appointments_sync', (select count(*) from information_schema.columns where table_name='appointments' and column_name='carestack_sync_status'),
    'appointments_csid', (select count(*) from information_schema.columns where table_name='appointments' and column_name='carestack_appointment_id'),
    'booking_settings_cs', (select count(*) from information_schema.columns where table_name='booking_settings' and column_name='carestack_location_id'),
    'organizations_dion', (select count(*) from information_schema.columns where table_name='organizations' and column_name='dion_practice_id'),
    'ehr_busy_slots', (select count(*) from information_schema.tables where table_name='ehr_busy_slots')
  ) as result`)
  console.log('\nVerification (all should be 1):', verify)
}

main().catch((e) => { console.error('FAILED:', e?.message ?? e); process.exit(1) })
