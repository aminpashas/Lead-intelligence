/**
 * Apply ONLY the two booking-EHR migrations directly to the linked prod DB
 * (NOT a full `supabase db push` history replay — that's unsafe on this repo).
 * Reads the pooler connection string from the CLI's link state; never prints it.
 *   npx tsx scripts/apply-booking-migrations.ts
 */
import { readFileSync } from 'fs'
 
import pg from 'pg'

const raw = readFileSync('supabase/.temp/pooler-url', 'utf8').trim()
// The file is a plain connection string; tolerate an accidental JSON wrapper.
const connectionString = raw.startsWith('postgres')
  ? raw
  : (JSON.parse(raw).db_url || JSON.parse(raw).url || JSON.parse(raw).connectionString)

const FILES = [
  'supabase/migrations/20260701_ehr_appointment_sync.sql',
  'supabase/migrations/20260701_ehr_busy_slots.sql',
]

async function main() {
  const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } })
  await client.connect()
  try {
    for (const f of FILES) {
      const sql = readFileSync(f, 'utf8')
      process.stdout.write(`Applying ${f} ... `)
      await client.query(sql)
      console.log('✓')
    }

    const check = await client.query(`
      select
        (select count(*) from information_schema.columns where table_name='appointments'      and column_name='carestack_sync_status')   as appointments_sync_cols,
        (select count(*) from information_schema.columns where table_name='appointments'      and column_name='carestack_appointment_id') as appointments_csid,
        (select count(*) from information_schema.columns where table_name='booking_settings'  and column_name='carestack_location_id')    as booking_settings_cs,
        (select count(*) from information_schema.columns where table_name='organizations'     and column_name='dion_practice_id')         as organizations_dion,
        (select count(*) from information_schema.tables  where table_name='ehr_busy_slots')                                              as ehr_busy_slots_table
    `)
    console.log('\nVerification (all should be 1):')
    console.log(check.rows[0])
  } finally {
    await client.end()
  }
}

main().catch((e) => {
  console.error('FAILED:', e?.message ?? e)
  process.exit(1)
})
