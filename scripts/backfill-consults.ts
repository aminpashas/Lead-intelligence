/**
 * Backfill CareStack appointments → ehr_appointments, then roll consult
 * outcomes (show / no-show / consult dates) onto leads.
 *
 *   npx tsx scripts/backfill-consults.ts --dry-run   # sync appts, preview lead changes
 *   npx tsx scripts/backfill-consults.ts             # sync appts + write lead consult cols
 *
 * The appointment sync itself always writes (into ehr_appointments — additive,
 * safe); --dry-run only gates the lead consult rollup.
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { getCareStackConfig } from '../src/lib/ehr/carestack/client'
import { syncCareStackAppointments } from '../src/lib/ehr/carestack/sync'
import { rollupConsultOutcomes } from '../src/lib/ehr/carestack/rollup'

function req(n: string): string {
  const v = process.env[n]
  if (!v) { console.error(`Missing env: ${n}`); process.exit(1) }
  return v
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const supabase = createClient(req('NEXT_PUBLIC_SUPABASE_URL'), req('SUPABASE_SERVICE_ROLE_KEY'))

  const { data: orgs } = await supabase
    .from('connector_configs').select('organization_id')
    .eq('connector_type', 'carestack').eq('enabled', true)
  if (!orgs || orgs.length === 0) { console.log('No CareStack orgs.'); return }

  for (const org of orgs as Array<{ organization_id: string }>) {
    const config = await getCareStackConfig(supabase, org.organization_id)
    if (!config) { console.log(`org ${org.organization_id}: config invalid`); continue }
    console.log(`\norg ${org.organization_id}`)

    // Drain the appointment cursor (each call does up to MAX_PAGES_PER_RUN pages).
    let total = 0
    for (let i = 0; i < 100; i++) {
      const r = await syncCareStackAppointments(supabase, org.organization_id, config)
      total += r.upserted
      console.log(`  appt sync pass ${i + 1}: +${r.upserted} (${r.status})`)
      if (r.status === 'failed') { console.log(`    FAILED: ${r.error}`); break }
      if (r.status === 'success') break // cursor exhausted
    }
    console.log(`  appointments upserted total: ${total}`)

    const c = await rollupConsultOutcomes(supabase, org.organization_id, { dryRun })
    if (c.status === 'failed') { console.log(`  consult rollup FAILED: ${c.error}`); continue }
    console.log(`  consult rollup: ${c.leads_examined} leads w/ appts, ${dryRun ? 'WOULD update' : 'updated'} ${c.leads_updated}`)
  }
  console.log('')
}

main().catch((e) => { console.error(e); process.exit(1) })
