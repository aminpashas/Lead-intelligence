/**
 * Contract variable resolution.
 *
 * Builds the ContractContext from DB rows (case + plan + closing + lead + org)
 * and flattens it into a dotted-key variable map for {{variable}} merge in
 * boilerplate/consent section bodies.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  ContractContext,
  ContractVariableMap,
  FinancialSummary,
  PhaseRow,
  TreatmentPlanItem,
} from './types'
import type { OrgLegalSettings, OrgContractSettings } from '@/types/database'

const DEFAULT_LEGAL: OrgLegalSettings = {
  entity_name: null,
  state_of_formation: null,
  license_numbers: {},
  principal_address: null,
  attorney_contact: null,
  arbitration_venue: null,
  cancellation_policy_days: 3,
  refund_policy_days: 30,
  governing_law: null,
  esign_disclosure_version: 'v1-2026',
}

const DEFAULT_CONTRACT_SETTINGS: OrgContractSettings = {
  signature_type_allowed: ['drawn', 'typed'],
  send_method_default: 'email',
  share_token_expiry_days: 30,
  auto_draft_on_ehr_accept: true,
}

function formatAddressOneLine(addr: OrgLegalSettings['principal_address']): string | null {
  if (!addr) return null
  const { street, city, state, zip } = addr
  return [street, city && state ? `${city}, ${state}` : city || state, zip].filter(Boolean).join(', ')
}

function formatCurrency(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
}

function parseLegal(raw: unknown): OrgLegalSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_LEGAL }
  const r = raw as Record<string, unknown>
  return {
    entity_name: typeof r.entity_name === 'string' ? r.entity_name : null,
    state_of_formation: typeof r.state_of_formation === 'string' ? r.state_of_formation : null,
    license_numbers: (r.license_numbers && typeof r.license_numbers === 'object'
      ? (r.license_numbers as Record<string, string>)
      : {}),
    principal_address: (r.principal_address && typeof r.principal_address === 'object'
      ? (r.principal_address as OrgLegalSettings['principal_address'])
      : null),
    attorney_contact: (r.attorney_contact && typeof r.attorney_contact === 'object'
      ? (r.attorney_contact as OrgLegalSettings['attorney_contact'])
      : null),
    arbitration_venue: typeof r.arbitration_venue === 'string' ? r.arbitration_venue : null,
    cancellation_policy_days: typeof r.cancellation_policy_days === 'number' ? r.cancellation_policy_days : 3,
    refund_policy_days: typeof r.refund_policy_days === 'number' ? r.refund_policy_days : 30,
    governing_law: typeof r.governing_law === 'string' ? r.governing_law : null,
    esign_disclosure_version: typeof r.esign_disclosure_version === 'string' ? r.esign_disclosure_version : 'v1-2026',
  }
}

function parseContractSettings(raw: unknown): OrgContractSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_CONTRACT_SETTINGS }
  const r = raw as Record<string, unknown>
  const sigAllowed = Array.isArray(r.signature_type_allowed)
    ? (r.signature_type_allowed as ('drawn' | 'typed')[])
    : DEFAULT_CONTRACT_SETTINGS.signature_type_allowed
  return {
    signature_type_allowed: sigAllowed,
    send_method_default: (r.send_method_default as OrgContractSettings['send_method_default']) ?? 'email',
    share_token_expiry_days: typeof r.share_token_expiry_days === 'number' ? r.share_token_expiry_days : 30,
    auto_draft_on_ehr_accept: typeof r.auto_draft_on_ehr_accept === 'boolean' ? r.auto_draft_on_ehr_accept : true,
  }
}

function scrubChiefComplaint(chief: string | null): string {
  if (!chief) return 'implant treatment as discussed'
  // Remove anything that looks like a phone/email/SSN/number run
  let s = chief
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[redacted]')
    .replace(/\+?\d[\d\s\-().]{6,}\d/g, '[redacted]')
    .replace(/\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g, '[redacted]')
    .replace(/\b\d{4,}\b/g, '[redacted]')
    .replace(/\$\s*\d[\d,.]*/g, '[amount]')
  // Cap length so the AI prompt is bounded
  if (s.length > 400) s = s.slice(0, 400) + '…'
  return s
}

function buildPhaseRows(items: TreatmentPlanItem[] | null | undefined): PhaseRow[] {
  if (!items || !Array.isArray(items)) return []
  return items
    .map((item, idx) => {
      const phase = typeof item.phase === 'number' && item.phase > 0 ? item.phase : 1
      const teeth = Array.isArray(item.tooth_numbers)
        ? item.tooth_numbers.join(', ')
        : typeof item.tooth_numbers === 'string'
          ? item.tooth_numbers
          : ''
      return {
        phase,
        procedure: item.procedure || `Procedure ${idx + 1}`,
        description: item.description || '',
        tooth_numbers: teeth,
        estimated_cost: typeof item.estimated_cost === 'number' ? item.estimated_cost : 0,
        cdt_code: item.cdt_code || '',
      }
    })
    .sort((a, b) => a.phase - b.phase)
}

function buildPhaseItemCounts(phases: PhaseRow[]): number[] {
  const counts: Record<number, number> = {}
  for (const p of phases) counts[p.phase] = (counts[p.phase] || 0) + 1
  const keys = Object.keys(counts).map(Number).sort((a, b) => a - b)
  return keys.map((k) => counts[k])
}

export type BuildContextInput = {
  supabase: SupabaseClient
  organizationId: string
  caseId: string
}

export async function buildContractContext(
  input: BuildContextInput
): Promise<{ context: ContractContext; missingLegal: string[] } | { error: string }> {
  const { supabase, organizationId, caseId } = input

  const { data: caseRow, error: caseErr } = await supabase
    .from('clinical_cases')
    .select(`
      id, organization_id, lead_id, patient_name, patient_email, patient_phone,
      chief_complaint, case_number, status
    `)
    .eq('id', caseId)
    .eq('organization_id', organizationId)
    .single()

  if (caseErr || !caseRow) return { error: 'Case not found' }

  const { data: planRow } = await supabase
    .from('case_treatment_plans')
    .select('id, plan_summary, total_estimated_cost, estimated_duration, phases, items')
    .eq('case_id', caseId)
    .maybeSingle()

  // Treatment closing may or may not exist yet
  let closingRow: {
    id: string
    contract_amount: number | null
    deposit_amount: number | null
    financing_type: FinancialSummary['financing_type']
    financing_monthly_payment: number | null
  } | null = null
  if (caseRow.lead_id) {
    const { data: tc } = await supabase
      .from('treatment_closings')
      .select('id, contract_amount, deposit_amount, financing_type, financing_monthly_payment')
      .eq('lead_id', caseRow.lead_id)
      .maybeSingle()
    closingRow = tc ?? null
  }

  // Lead (for financing + insurance context)
  let leadRow: {
    first_name: string | null
    last_name: string | null
    city: string | null
    state: string | null
    zip_code: string | null
    financing_approved: boolean | null
    financing_amount: number | null
  } | null = null
  if (caseRow.lead_id) {
    const { data: l } = await supabase
      .from('leads')
      .select('first_name, last_name, city, state, zip_code, financing_approved, financing_amount')
      .eq('id', caseRow.lead_id)
      .maybeSingle()
    leadRow = l ?? null
  }

  const { data: orgRow } = await supabase
    .from('organizations')
    .select('name, logo_url, settings')
    .eq('id', organizationId)
    .single()

  const settings = (orgRow?.settings ?? {}) as Record<string, unknown>
  const legal = parseLegal(settings.legal)
  const contractSettings = parseContractSettings(settings.contracts)

  // Validate required legal settings
  const missingLegal: string[] = []
  if (!legal.entity_name) missingLegal.push('legal.entity_name')
  if (!legal.state_of_formation) missingLegal.push('legal.state_of_formation')
  if (!legal.principal_address) missingLegal.push('legal.principal_address')
  if (!legal.arbitration_venue) missingLegal.push('legal.arbitration_venue')
  if (!legal.governing_law) missingLegal.push('legal.governing_law')

  const phases = buildPhaseRows((planRow?.items as TreatmentPlanItem[]) ?? [])
  const phaseCount = phases.length > 0 ? Math.max(...phases.map((p) => p.phase)) : (planRow?.phases ?? 0)
  const phaseItemCounts = buildPhaseItemCounts(phases)

  const contractAmount =
    closingRow?.contract_amount ??
    planRow?.total_estimated_cost ??
    (leadRow?.financing_amount ?? null) ??
    0

  const financial: FinancialSummary = {
    contract_amount: typeof contractAmount === 'number' ? contractAmount : 0,
    deposit_amount: typeof closingRow?.deposit_amount === 'number' ? closingRow.deposit_amount : 0,
    financing_type: closingRow?.financing_type ?? null,
    financing_monthly_payment: closingRow?.financing_monthly_payment ?? null,
    total_patient_estimate: planRow?.total_estimated_cost ?? null,
    total_insurance_estimate: null,
  }

  const fullName = caseRow.patient_name
  const firstName = leadRow?.first_name ?? (fullName ? fullName.split(' ')[0] : 'Patient')
  const addressOneLine = [
    [leadRow?.city, leadRow?.state].filter(Boolean).join(', '),
    leadRow?.zip_code,
  ]
    .filter(Boolean)
    .join(' ') || null

  const today = new Date().toISOString().slice(0, 10)

  const variables: ContractVariableMap = {
    'today': today,
    'org.name': orgRow?.name ?? '',
    'patient.full_name': fullName,
    'patient.first_name': firstName,
    'patient.address_oneline': addressOneLine ?? '',
    'legal.entity_name': legal.entity_name ?? '',
    'legal.state_of_formation': legal.state_of_formation ?? '',
    'legal.principal_address_oneline': formatAddressOneLine(legal.principal_address) ?? '',
    'legal.arbitration_venue': legal.arbitration_venue ?? '',
    'legal.governing_law': legal.governing_law ?? '',
    'legal.cancellation_policy_days': legal.cancellation_policy_days,
    'legal.refund_policy_days': legal.refund_policy_days,
    'financial.financing_type': financial.financing_type ?? 'cash',
    'financial.financing_monthly_payment': financial.financing_monthly_payment ?? 0,
    'financial.contract_amount': financial.contract_amount,
    'financial.contract_amount_formatted': formatCurrency(financial.contract_amount),
    'financial.deposit_amount': financial.deposit_amount,
    'financial.deposit_amount_formatted': formatCurrency(financial.deposit_amount),
    'financial.financing_monthly_payment_formatted': formatCurrency(financial.financing_monthly_payment),
  }

  const context: ContractContext = {
    organization_id: organizationId,
    case_id: caseId,
    lead_id: caseRow.lead_id ?? null,
    treatment_closing_id: closingRow?.id ?? null,
    case_treatment_plan_id: planRow?.id ?? null,

    legal,
    contract_settings: contractSettings,
    org_name: orgRow?.name ?? '',
    org_logo_url: orgRow?.logo_url ?? null,

    patient: {
      full_name: fullName,
      first_name: firstName,
      email: caseRow.patient_email ?? null,
      phone: caseRow.patient_phone ?? null,
      address_oneline: addressOneLine,
    },
    clinical_summary: {
      chief_complaint_scrubbed: scrubChiefComplaint(caseRow.chief_complaint ?? null),
      phase_count: phaseCount,
      phase_item_counts: phaseItemCounts,
    },
    financial,
    phases,
    variables,
    today,
  }

  return { context, missingLegal }
}

/**
 * Resolve {{variable}} tokens in a string against a flat variable map.
 * Unknown variables are left as {{var}} and pushed to `missing` for the caller
 * to decide whether to fail loudly or proceed.
 */
export function resolveContractVariables(
  body: string,
  vars: ContractVariableMap
): { rendered: string; missing: string[] } {
  const missing: string[] = []
  const rendered = body.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (_match, key: string) => {
    if (key in vars && vars[key] != null) {
      const v = vars[key]
      return typeof v === 'number' ? String(v) : v
    }
    missing.push(key)
    return `{{${key}}}`
  })
  return { rendered, missing }
}

export { formatCurrency }
