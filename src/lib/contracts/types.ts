/**
 * Contract generation — internal types and context shapes.
 *
 * Public DB-row types live in src/types/database.ts. This file holds the runtime
 * shapes used by the renderer, variable resolver, and AI generator.
 */

import type {
  ContractTemplateSection,
  RenderedContractSection,
  OrgLegalSettings,
  OrgContractSettings,
} from '@/types/database'

export type TreatmentPlanItem = {
  procedure?: string
  description?: string
  tooth_numbers?: string | string[]
  phase?: number
  estimated_cost?: number
  cdt_code?: string
  notes?: string
}

export type PhaseRow = {
  phase: number
  procedure: string
  description: string
  tooth_numbers: string
  estimated_cost: number
  cdt_code: string
}

export type FinancialSummary = {
  contract_amount: number
  deposit_amount: number
  financing_type: 'loan' | 'in_house' | 'cash' | 'insurance' | null
  financing_monthly_payment: number | null
  total_patient_estimate: number | null
  total_insurance_estimate: number | null
}

/**
 * Flat variable map used for {{variable}} token resolution in boilerplate /
 * consent section bodies. Keys are dotted paths matching template
 * required_variables (e.g. "legal.entity_name", "patient.full_name").
 */
export type ContractVariableMap = Record<string, string | number | null>

export type ContractContext = {
  organization_id: string
  case_id: string
  lead_id: string | null
  treatment_closing_id: string | null
  case_treatment_plan_id: string | null

  legal: OrgLegalSettings
  contract_settings: OrgContractSettings
  org_name: string
  org_logo_url: string | null

  patient: {
    full_name: string
    first_name: string
    email: string | null
    phone: string | null
    address_oneline: string | null
  }
  // Scrubbed, generic — safe to send to the AI
  clinical_summary: {
    chief_complaint_scrubbed: string
    phase_count: number
    phase_item_counts: number[]
  }

  financial: FinancialSummary
  phases: PhaseRow[]

  variables: ContractVariableMap
  today: string // ISO date
}

export type AiSectionOutput = {
  section_id: string
  content: string
}

export type AiGenerateResult = {
  sections: AiSectionOutput[]
  tokens_in: number
  tokens_out: number
  model: string
  duration_ms: number
}

export type ValidationIssue = {
  section_id: string
  severity: 'warning' | 'violation'
  category: 'forbidden_number' | 'forbidden_code' | 'drug_reference' | 'guarantee_language' | 'phi_leakage' | 'word_count' | 'missing'
  description: string
}

export type ValidationResult = {
  isValid: boolean
  issues: ValidationIssue[]
}

export type RenderInput = {
  template_sections: ContractTemplateSection[]
  ai_output: AiSectionOutput[] | null
  context: ContractContext
}

export type RenderOutput = {
  generated_content: RenderedContractSection[]
  missing_variables: string[]
}
