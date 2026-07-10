/**
 * Tear down the DEMO contract seeded by scripts/seed-demo-contract.ts:
 * the patient_contracts row(s) + contract_events, the DEMO-0001 clinical
 * case, its treatment plan + closing, and the demo lead.
 *
 * Usage: npx tsx scripts/delete-demo-contract.ts [--dry-run]
 * Env (from .env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'

const ORG_ID = 'fa64e53c-3d9b-493e-b904-59580cb3f29c' // SF Dentistry
const CASE_NUMBER = 'DEMO-0001'
const DRY = process.argv.includes('--dry-run')

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  const { data: caseRow } = await supabase
    .from('clinical_cases')
    .select('id, lead_id')
    .eq('organization_id', ORG_ID)
    .eq('case_number', CASE_NUMBER)
    .maybeSingle()

  if (!caseRow) {
    console.log('No demo case found — nothing to delete.')
    return
  }

  const { data: contracts } = await supabase
    .from('patient_contracts')
    .select('id')
    .eq('clinical_case_id', caseRow.id)
  const contractIds = (contracts ?? []).map((c) => c.id)

  console.log(`${DRY ? '[dry-run] would delete' : 'Deleting'}:`)
  console.log('  case', caseRow.id, '/ lead', caseRow.lead_id, '/ contracts', contractIds.length)
  if (DRY) return

  for (const cid of contractIds) {
    await supabase.from('contract_events').delete().eq('contract_id', cid)
  }
  await supabase.from('patient_contracts').delete().eq('clinical_case_id', caseRow.id)
  await supabase.from('treatment_closings').delete().eq('clinical_case_id', caseRow.id)
  await supabase.from('case_treatment_plans').delete().eq('case_id', caseRow.id)
  await supabase.from('clinical_cases').delete().eq('id', caseRow.id)
  if (caseRow.lead_id) await supabase.from('leads').delete().eq('id', caseRow.lead_id)

  console.log('✅ Demo contract + case + lead removed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
