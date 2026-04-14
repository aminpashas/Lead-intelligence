/**
 * Treatment Closing Workflow Engine
 *
 * Manages the complete closing process from treatment plan presentation
 * to surgery day. Tracks 7 sequential steps:
 *
 * 1. Treatment Plan Presented → 2. Contract Signed → 3. Financing Funded →
 * 4. Consent Signed → 5. Pre-Op Instructions Sent → 6. Surgery Scheduled →
 * 7. Records Confirmed
 *
 * Each step can be advanced independently by the AI agent or office staff.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { TreatmentClosing, TreatmentClosingStep, RecordsChecklist } from '@/types/database'

// Step order for workflow progression
const STEP_ORDER: TreatmentClosingStep[] = [
  'treatment_plan_presented',
  'contract_signed',
  'financing_funded',
  'consent_signed',
  'preop_instructions_sent',
  'surgery_scheduled',
  'records_confirmed',
]

const STEP_LABELS: Record<TreatmentClosingStep, string> = {
  treatment_plan_presented: 'Treatment Plan Presented',
  contract_signed: 'Contract Signed',
  financing_funded: 'Financing / Payment Funded',
  consent_signed: 'Consent Forms Signed',
  preop_instructions_sent: 'Pre-Op Instructions Sent',
  surgery_scheduled: 'Surgery Date Scheduled',
  records_confirmed: 'Records & Availability Confirmed',
}

// ════════════════════════════════════════════════════════════════
// CREATE & QUERY
// ════════════════════════════════════════════════════════════════

/**
 * Create a new treatment closing record for a lead.
 * Called when treatment is presented post-consultation.
 */
export async function createTreatmentClosing(
  supabase: SupabaseClient,
  leadId: string,
  organizationId: string,
  contractAmount?: number
): Promise<TreatmentClosing | null> {
  // Check if one already exists
  const { data: existing } = await supabase
    .from('treatment_closings')
    .select('*')
    .eq('lead_id', leadId)
    .single()

  if (existing) return existing as TreatmentClosing

  const { data, error } = await supabase
    .from('treatment_closings')
    .insert({
      lead_id: leadId,
      organization_id: organizationId,
      current_step: 'treatment_plan_presented',
      steps_completed: ['treatment_plan_presented'],
      contract_amount: contractAmount || null,
    })
    .select()
    .single()

  if (error) {
    console.error('[TreatmentClosing] Create error:', error)
    return null
  }

  return data as TreatmentClosing
}

/**
 * Get the treatment closing record for a lead.
 */
export async function getTreatmentClosing(
  supabase: SupabaseClient,
  leadId: string
): Promise<TreatmentClosing | null> {
  const { data } = await supabase
    .from('treatment_closings')
    .select('*')
    .eq('lead_id', leadId)
    .single()

  return (data as TreatmentClosing) || null
}

// ════════════════════════════════════════════════════════════════
// STEP ADVANCEMENT
// ════════════════════════════════════════════════════════════════

type StepData = {
  // Contract
  contract_amount?: number
  deposit_amount?: number
  non_refundable_acknowledged?: boolean

  // Financing
  financing_type?: 'loan' | 'in_house' | 'cash' | 'insurance'
  financing_monthly_payment?: number

  // Consent
  consent_forms?: string[]

  // Pre-Op
  preop_sent_via?: 'sms' | 'email' | 'both'

  // Surgery
  surgery_date?: string
  surgery_time?: string
  surgery_type?: string
  estimated_duration_hours?: number

  // Records
  records_checklist?: Partial<RecordsChecklist>

  // Notes
  notes?: string
}

/**
 * Advance the treatment closing to a specific step.
 * Validates that prior steps are completed.
 */
export async function advanceStep(
  supabase: SupabaseClient,
  leadId: string,
  step: TreatmentClosingStep,
  data: StepData = {}
): Promise<{ success: boolean; closing: TreatmentClosing | null; error?: string }> {
  const closing = await getTreatmentClosing(supabase, leadId)
  if (!closing) {
    return { success: false, closing: null, error: 'No treatment closing record found for this lead.' }
  }

  const currentIndex = STEP_ORDER.indexOf(closing.current_step)
  const targetIndex = STEP_ORDER.indexOf(step)

  // Can't go backwards
  if (targetIndex < currentIndex) {
    return { success: false, closing, error: `Step "${step}" is before current step "${closing.current_step}".` }
  }

  // Build update fields based on step
  const now = new Date().toISOString()
  const updates: Record<string, unknown> = {
    current_step: step,
    steps_completed: [...new Set([...closing.steps_completed, step])],
  }

  switch (step) {
    case 'contract_signed':
      updates.contract_signed_at = now
      if (data.contract_amount) updates.contract_amount = data.contract_amount
      if (data.deposit_amount) updates.deposit_amount = data.deposit_amount
      if (data.deposit_amount) updates.deposit_collected_at = now
      if (data.non_refundable_acknowledged !== undefined) updates.non_refundable_acknowledged = data.non_refundable_acknowledged
      break

    case 'financing_funded':
      updates.financing_funded_at = now
      if (data.financing_type) updates.financing_type = data.financing_type
      if (data.financing_monthly_payment) updates.financing_monthly_payment = data.financing_monthly_payment
      break

    case 'consent_signed':
      updates.consent_signed_at = now
      if (data.consent_forms) updates.consent_forms = data.consent_forms
      break

    case 'preop_instructions_sent':
      updates.preop_instructions_sent_at = now
      updates.postop_instructions_sent_at = now
      if (data.preop_sent_via) updates.preop_sent_via = data.preop_sent_via
      break

    case 'surgery_scheduled':
      if (data.surgery_date) updates.surgery_date = data.surgery_date
      if (data.surgery_time) updates.surgery_time = data.surgery_time
      if (data.surgery_type) updates.surgery_type = data.surgery_type
      if (data.estimated_duration_hours) updates.estimated_duration_hours = data.estimated_duration_hours
      break

    case 'records_confirmed':
      updates.records_confirmed_at = now
      if (data.records_checklist) {
        updates.records_checklist = {
          ...closing.records_checklist,
          ...data.records_checklist,
        }
      }
      break
  }

  if (data.notes) {
    updates.notes = closing.notes
      ? `${closing.notes}\n[${new Date().toLocaleDateString()}] ${data.notes}`
      : `[${new Date().toLocaleDateString()}] ${data.notes}`
  }

  const { data: updated, error } = await supabase
    .from('treatment_closings')
    .update(updates)
    .eq('id', closing.id)
    .select()
    .single()

  if (error) {
    console.error('[TreatmentClosing] Advance error:', error)
    return { success: false, closing, error: error.message }
  }

  // Update lead status to match the closing workflow
  const statusMap: Partial<Record<TreatmentClosingStep, string>> = {
    contract_signed: 'contract_signed',
    surgery_scheduled: 'scheduled',
    records_confirmed: 'in_treatment',
  }

  if (statusMap[step]) {
    await supabase
      .from('leads')
      .update({ status: statusMap[step] })
      .eq('id', leadId)
  }

  return { success: true, closing: updated as TreatmentClosing }
}

// ════════════════════════════════════════════════════════════════
// PROGRESS & NEXT ACTIONS
// ════════════════════════════════════════════════════════════════

export type ClosingProgress = {
  current_step: TreatmentClosingStep
  current_step_label: string
  steps_completed: TreatmentClosingStep[]
  steps_remaining: TreatmentClosingStep[]
  percent_complete: number
  next_action: string
  next_action_detail: string
  days_since_start: number
  surgery_in_days: number | null
  blockers: string[]
}

/**
 * Get comprehensive closing progress for display or AI context.
 */
export function getClosingProgress(closing: TreatmentClosing): ClosingProgress {
  const completedSet = new Set(closing.steps_completed)
  const remaining = STEP_ORDER.filter(s => !completedSet.has(s))
  const percent = Math.round((closing.steps_completed.length / STEP_ORDER.length) * 100)

  const daysSinceStart = Math.floor(
    (Date.now() - new Date(closing.created_at).getTime()) / (1000 * 60 * 60 * 24)
  )

  let surgeryInDays: number | null = null
  if (closing.surgery_date) {
    surgeryInDays = Math.floor(
      (new Date(closing.surgery_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    )
  }

  // Determine next action and blockers
  const { action, detail, blockers } = getNextAction(closing, remaining)

  return {
    current_step: closing.current_step,
    current_step_label: STEP_LABELS[closing.current_step],
    steps_completed: closing.steps_completed,
    steps_remaining: remaining,
    percent_complete: percent,
    next_action: action,
    next_action_detail: detail,
    days_since_start: daysSinceStart,
    surgery_in_days: surgeryInDays,
    blockers,
  }
}

function getNextAction(
  closing: TreatmentClosing,
  remaining: TreatmentClosingStep[]
): { action: string; detail: string; blockers: string[] } {
  const blockers: string[] = []

  if (remaining.length === 0) {
    return { action: 'All steps complete!', detail: 'Patient is ready for treatment.', blockers }
  }

  const nextStep = remaining[0]

  switch (nextStep) {
    case 'contract_signed':
      return {
        action: 'Get Treatment Plan Contract Signed',
        detail: 'Patient needs to sign the treatment plan contract with the non-refundable clause. Send the contract or schedule an in-office signing.',
        blockers,
      }

    case 'financing_funded':
      if (!closing.contract_signed_at) blockers.push('Contract not yet signed')
      return {
        action: 'Fund Financing or Collect Deposit',
        detail: closing.financing_type === 'loan'
          ? 'Loan needs to be funded by the financing company. Follow up with the lender.'
          : closing.financing_type === 'cash'
            ? `Collect deposit of $${closing.deposit_amount || 'TBD'}. Send payment link or schedule office visit.`
            : 'Determine payment method (loan, in-house plan, cash, or insurance) and process payment.',
        blockers,
      }

    case 'consent_signed':
      if (!closing.financing_funded_at) blockers.push('Financing not yet funded')
      return {
        action: 'Get Consent Forms Signed',
        detail: 'Patient needs to sign surgical consent, anesthesia consent, and any other required forms. Can be done digitally or in-office.',
        blockers,
      }

    case 'preop_instructions_sent':
      if (!closing.consent_signed_at) blockers.push('Consent forms not yet signed')
      return {
        action: 'Send Pre-Op & Post-Op Instructions',
        detail: 'Deliver pre-operative instructions (fasting, medications, ride arrangements) and post-operative care guide via SMS and/or email.',
        blockers,
      }

    case 'surgery_scheduled':
      return {
        action: 'Schedule Surgery Date',
        detail: 'Confirm a surgery date with the patient. Coordinate with the surgical team, lab, and anesthesiologist.',
        blockers,
      }

    case 'records_confirmed': {
      if (!closing.surgery_date) blockers.push('Surgery not yet scheduled')
      const checklist = closing.records_checklist
      const missing: string[] = []
      if (!checklist.medical_records) missing.push('medical records')
      if (!checklist.dental_records) missing.push('dental records')
      if (!checklist.ct_scan) missing.push('CT scan')
      if (!checklist.prescription_ready) missing.push('prescription')
      if (!checklist.surgical_guide_ready) missing.push('surgical guide')
      if (!checklist.lab_work_ordered) missing.push('lab work')
      if (!checklist.anesthesia_confirmed) missing.push('anesthesia confirmation')
      if (!checklist.surgeon_availability) missing.push('surgeon availability')
      if (missing.length > 0) blockers.push(`Missing: ${missing.join(', ')}`)

      return {
        action: 'Confirm All Records & Availability',
        detail: `Office needs to confirm: ${missing.length > 0 ? missing.join(', ') : 'all items ready!'}`,
        blockers,
      }
    }

    default:
      return { action: 'Continue closing workflow', detail: 'Proceed to the next step.', blockers }
  }
}

/**
 * Format closing progress for the AI agent's context.
 */
export function formatClosingForPrompt(closing: TreatmentClosing): string {
  const progress = getClosingProgress(closing)

  const lines = [
    `═══ TREATMENT CLOSING STATUS ═══`,
    `Current Step: ${progress.current_step_label} (${progress.percent_complete}% complete)`,
    `Steps Completed: ${progress.steps_completed.map(s => STEP_LABELS[s]).join(' → ')}`,
    `Next Action: ${progress.next_action}`,
    `Detail: ${progress.next_action_detail}`,
    `Days in Pipeline: ${progress.days_since_start}`,
  ]

  if (progress.surgery_in_days !== null) {
    lines.push(`Surgery In: ${progress.surgery_in_days} days`)
  }

  if (closing.contract_amount) {
    lines.push(`Treatment Value: $${closing.contract_amount.toLocaleString()}`)
  }

  if (closing.financing_monthly_payment) {
    lines.push(`Monthly Payment: $${closing.financing_monthly_payment}/mo`)
  }

  if (progress.blockers.length > 0) {
    lines.push(`⚠️ Blockers: ${progress.blockers.join('; ')}`)
  }

  return lines.join('\n')
}
