/**
 * One-off: seed a DEMO clinical case (+ lead, treatment plan, closing) for
 * SF Dentistry and run the real contract orchestrator so a genuine
 * patient_contracts row appears on the /contracts page for review.
 *
 * Nothing is sent to any patient — this only creates a `pending_review`
 * draft. All rows are clearly labelled DEMO so they can be deleted later
 * (see scripts/delete-demo-contract.ts).
 *
 * PII note: variables.ts reads patient_name / lead.first_name WITHOUT
 * decryption, so demo names are stored plaintext on purpose.
 *
 * Idempotent: reuses the demo case (case_number DEMO-0001) if present, and
 * the orchestrator short-circuits if a non-terminal contract already exists.
 *
 * Usage: npx tsx scripts/seed-demo-contract.ts
 * Env (from .env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { ensureContractDraftForCase } from '../src/lib/contracts/orchestrator'

const ORG_ID = 'fa64e53c-3d9b-493e-b904-59580cb3f29c' // SF Dentistry
const DEMO_USER_ID = '76308877-f882-409e-a3bd-c90f76f45881' // frontdesk.demo (nurse)
const CASE_NUMBER = 'DEMO-0001'

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  if (!url || !key) throw new Error('Missing Supabase env')
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('⚠️  ANTHROPIC_API_KEY not set — orchestrator will fall back to needs_manual_draft.')
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } })

  // ── 1. Reuse or create the demo clinical case ────────────────────────────
  let caseId: string
  const { data: existingCase } = await supabase
    .from('clinical_cases')
    .select('id, lead_id')
    .eq('organization_id', ORG_ID)
    .eq('case_number', CASE_NUMBER)
    .maybeSingle()

  if (existingCase) {
    caseId = existingCase.id
    console.log('Reusing demo case', caseId)
  } else {
    // 1a. Demo lead (plaintext PII on purpose — see file header). Reuse an
    // existing demo lead so partial-failure reruns don't duplicate it.
    let lead: { id: string }
    const { data: existingLead } = await supabase
      .from('leads')
      .select('id')
      .eq('organization_id', ORG_ID)
      .eq('last_name', 'Rivera (DEMO)')
      .maybeSingle()
    if (existingLead) {
      lead = existingLead
    } else {
      const { data: newLead, error: leadErr } = await supabase
        .from('leads')
        .insert({
          organization_id: ORG_ID,
          first_name: 'Jordan',
          last_name: 'Rivera (DEMO)',
          city: 'San Francisco',
          state: 'CA',
          zip_code: '94110',
          date_of_birth: '1978-04-12',
          financing_approved: true,
          financing_amount: 32000,
        })
        .select('id')
        .single()
      if (leadErr) throw leadErr
      lead = newLead
    }

    // 1b. Clinical case, marked treatment-accepted so a contract is warranted
    const now = new Date().toISOString()
    const { data: caseRow, error: caseErr } = await supabase
      .from('clinical_cases')
      .insert({
        organization_id: ORG_ID,
        lead_id: lead.id,
        patient_name: 'Jordan Rivera (DEMO)',
        patient_email: 'jordan.rivera.demo@example.com',
        patient_phone: '+14155550123',
        case_number: CASE_NUMBER,
        chief_complaint:
          'Failing upper dentition and multiple missing lower teeth; wants a fixed full-arch implant solution to restore chewing and confidence.',
        status: 'accepted',
        created_by: DEMO_USER_ID,
        treatment_planned_at: now,
        patient_accepted_at: now,
      })
      .select('id')
      .single()
    if (caseErr) throw caseErr
    caseId = caseRow.id
    console.log('Created demo lead', lead.id, 'and case', caseId)

    // 1c. Treatment plan — drives the procedures table + contract amount
    const items = [
      { phase: 1, procedure: 'Diagnostic CBCT + surgical guide', description: 'Cone-beam CT imaging and fabrication of a fully guided surgical stent.', tooth_numbers: [], estimated_cost: 1200, cdt_code: 'D0367' },
      { phase: 1, procedure: 'Extractions & alveoloplasty (upper arch)', description: 'Removal of remaining non-restorable upper teeth with bone recontouring.', tooth_numbers: [6, 7, 8, 9, 10, 11], estimated_cost: 3200, cdt_code: 'D7140' },
      { phase: 2, procedure: 'Full-arch implants (upper)', description: 'Placement of six endosteal implants to support a fixed upper prosthesis.', tooth_numbers: [], estimated_cost: 15600, cdt_code: 'D6010' },
      { phase: 2, procedure: 'Immediate fixed provisional (upper)', description: 'Same-day screw-retained provisional bridge.', tooth_numbers: [], estimated_cost: 4800, cdt_code: 'D6118' },
      { phase: 3, procedure: 'Final zirconia fixed prosthesis (upper)', description: 'Definitive milled zirconia full-arch bridge delivered after healing.', tooth_numbers: [], estimated_cost: 7200, cdt_code: 'D6114' },
    ]
    const total = items.reduce((s, i) => s + i.estimated_cost, 0) // 32000
    const { error: planErr } = await supabase.from('case_treatment_plans').insert({
      case_id: caseId,
      organization_id: ORG_ID,
      plan_summary:
        'Full-arch fixed implant reconstruction of the upper arch delivered in three phases: diagnostics and extractions, implant placement with an immediate provisional, and a final zirconia prosthesis.',
      total_estimated_cost: total,
      estimated_duration: '4–6 months',
      phases: 3,
      items,
      planned_by: DEMO_USER_ID,
      approved_at: now,
    })
    if (planErr) throw planErr

    // 1d. Treatment closing — deposit + financing (fetched by lead_id)
    const { error: closingErr } = await supabase.from('treatment_closings').insert({
      organization_id: ORG_ID,
      lead_id: lead.id,
      clinical_case_id: caseId,
      contract_amount: total,
      deposit_amount: 2000,
      financing_type: 'loan',
      financing_monthly_payment: 561,
      surgery_date: new Date(Date.now() + 21 * 86400_000).toISOString().slice(0, 10),
    })
    if (closingErr) throw closingErr
    console.log('Seeded treatment plan + closing (total $%d, deposit $2000, loan)', total)
  }

  // ── 2. Run the real orchestrator (AI draft → validate → render → insert) ──
  console.log('Running contract orchestrator…')
  const result = await ensureContractDraftForCase({
    supabase,
    organizationId: ORG_ID,
    caseId,
    actorId: DEMO_USER_ID,
    actorType: 'user',
  })

  if (!result.ok) {
    console.error('❌ Orchestrator failed:', result)
    process.exit(1)
  }

  console.log('\n✅ Contract ready')
  console.log('   contract_id       :', result.contract_id)
  console.log('   status            :', result.status)
  console.log('   needs_manual_draft:', result.needs_manual_draft)
  if (result.missing_variables.length) {
    console.log('   missing_variables :', result.missing_variables.join(', '))
  }
  console.log('\n   Open it at: /contracts/' + result.contract_id)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
