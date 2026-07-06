/**
 * Backfill / dry-run the CareStack → lead revenue rollup.
 *
 * Stamps treatment_value / actual_revenue / converted_at onto every lead that
 * links to a CareStack patient with accepted/completed procedures. This is the
 * "last mile" that lights up dashboards and feeds real $ into Google/Meta
 * offline conversions.
 *
 *   npx tsx scripts/rollup-lead-revenue.ts --dry-run   # preview, writes nothing
 *   npx tsx scripts/rollup-lead-revenue.ts             # live: writes to leads
 *
 * Runs for every org with a CareStack connector configured + enabled.
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { rollupLeadOutcomes } from '../src/lib/ehr/carestack/rollup'
import { rematchUnlinkedPatients } from '../src/lib/ehr/carestack/rematch'

function req(n: string): string {
  const v = process.env[n]
  if (!v) { console.error(`Missing env: ${n}`); process.exit(1) }
  return v
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const supabase = createClient(req('NEXT_PUBLIC_SUPABASE_URL'), req('SUPABASE_SERVICE_ROLE_KEY'))

  const { data: orgs, error } = await supabase
    .from('connector_configs')
    .select('organization_id')
    .eq('connector_type', 'carestack')
    .eq('enabled', true)
  if (error) { console.error('connector_configs read failed:', error.message); process.exit(1) }
  if (!orgs || orgs.length === 0) { console.log('No CareStack orgs configured.'); return }

  console.log(`\n=== Lead revenue rollup ${dryRun ? '(DRY RUN — no writes)' : '(LIVE)'} ===\n`)

  for (const org of orgs as Array<{ organization_id: string }>) {
    console.log(`org ${org.organization_id}`)

    // Re-link already-synced patients to their leads before rolling up.
    const rm = await rematchUnlinkedPatients(supabase, org.organization_id, { dryRun })
    if (rm.status === 'failed') {
      console.log(`  rematch FAILED: ${rm.error}`)
    } else {
      console.log(`  rematch: scanned ${rm.patients_scanned} unlinked, ${dryRun ? 'WOULD link' : 'linked'} ${rm.newly_matched} (email ${rm.by_email} / phone ${rm.by_phone})`)
    }

    const r = await rollupLeadOutcomes(supabase, org.organization_id, { dryRun })
    if (r.status === 'failed') { console.log(`  FAILED: ${r.error}`); continue }
    console.log(`  leads with revenue: ${r.leads_examined}`)
    console.log(`  leads ${dryRun ? 'that WOULD update' : 'updated'}: ${r.leads_updated}`)
    console.log(`  total treatment_value: $${r.total_treatment_value.toLocaleString()}`)
    console.log(`  total actual_revenue:  $${r.total_actual_revenue.toLocaleString()}`)
    if (dryRun && r.preview && r.preview.length) {
      console.log('  sample of planned changes (first 10):')
      for (const p of r.preview.slice(0, 10)) {
        console.log(`    lead ${p.lead_id.slice(0, 8)}…  $${p.from.treatment_value ?? 0} → $${p.to.treatment_value}  (rev $${p.to.actual_revenue}, converted ${p.to.converted_at?.slice(0, 10) ?? '—'})`)
      }
    }
  }
  console.log('')
}

main().catch((e) => { console.error(e); process.exit(1) })
