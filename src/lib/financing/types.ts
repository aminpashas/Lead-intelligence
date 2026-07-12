// ── Financing Lender Integration Types ──────────────────────────

export type LenderSlug = 'carecredit' | 'sunbit' | 'proceed' | 'lendingclub' | 'cherry' | 'alpheon' | 'affirm'
export type LenderIntegrationType = 'api' | 'link' | 'iframe'
// `awaiting_patient` is a terminal-but-positive outcome: the waterfall ran, no
// API lender auto-approved/declined, and one or more link-based lenders emitted
// an application URL the patient must complete on the lender's site. It is NOT a
// denial — leads must not be flagged un-financeable and the "sorry, denied"
// follow-up must not fire. See executeWaterfall's terminal decision.
export type FinancingApplicationStatus = 'pending' | 'in_progress' | 'approved' | 'denied' | 'error' | 'expired' | 'awaiting_patient'
export type FinancingSubmissionStatus = 'pending' | 'submitted' | 'approved' | 'denied' | 'error' | 'timeout' | 'link_sent'

// ── Database Row Types ──────────────────────────────────────────

export type FinancingLenderConfig = {
  id: string
  organization_id: string
  lender_slug: LenderSlug
  display_name: string
  is_active: boolean
  priority_order: number
  credentials_encrypted: string | null
  config: Record<string, unknown>
  integration_type: LenderIntegrationType
  created_at: string
  updated_at: string
}

export type ApprovedTerms = {
  apr: number
  term_months: number
  monthly_payment: number
  promo_period_months?: number
}

export type WaterfallConfig = {
  lenders: Array<{
    slug: LenderSlug
    priority: number
    integration_type: LenderIntegrationType
  }>
}

export type FinancingApplication = {
  id: string
  organization_id: string
  lead_id: string
  status: FinancingApplicationStatus
  applicant_data_encrypted: string
  applicant_ssn_hash: string | null
  requested_amount: number | null
  approved_lender_slug: LenderSlug | null
  approved_amount: number | null
  approved_terms: ApprovedTerms | null
  current_waterfall_step: number
  waterfall_config: WaterfallConfig
  consent_given_at: string
  consent_ip_address: string | null
  /** True when a substitute applicant (not the patient) filled out the form. */
  applied_on_behalf: boolean
  /** Relationship of the substitute applicant to the patient; null when applied_on_behalf is false. */
  applicant_relationship: ApplicantRelationship | null
  share_token: string | null
  expires_at: string
  completed_at: string | null
  /** First time a link was sent to the patient; never overwritten. */
  first_sent_at: string | null
  /** Most recent send/follow-up touch (initial send, manual follow-up, or reminder). */
  last_sent_at: string | null
  /** Count of automated reminder nudges sent for this pending link. */
  reminder_count: number
  last_reminder_at: string | null
  /** When the patient (or co-signer) actually completed the form. Distinct from completed_at (which also covers expiry). */
  submitted_at: string | null
  created_at: string
  updated_at: string
}

/** How a substitute applicant (someone applying on the patient's behalf) relates to the patient. */
export type ApplicantRelationship =
  | 'spouse'
  | 'parent'
  | 'adult_child'
  | 'other_family'
  | 'friend'
  | 'other'

export type FinancingSubmission = {
  id: string
  organization_id: string
  application_id: string
  lead_id: string
  lender_slug: LenderSlug
  waterfall_step: number
  status: FinancingSubmissionStatus
  external_application_id: string | null
  application_url: string | null
  response_data: Record<string, unknown> | null
  error_message: string | null
  submitted_at: string | null
  responded_at: string | null
  created_at: string
}

// ── Adapter Interface Types ─────────────────────────────────────

export type ApplicantAddress = {
  street: string
  city: string
  state: string
  zip: string
}

export type ApplicantData = {
  first_name: string
  last_name: string
  date_of_birth: string        // YYYY-MM-DD
  ssn: string                  // 9 digits, no dashes
  email: string
  phone: string
  address: ApplicantAddress
  annual_income: number
  employment_status: 'employed' | 'self_employed' | 'retired' | 'other'
  employer_name?: string
}

export type LenderCredentials = Record<string, string>

export type LenderConfig = Record<string, unknown>

export type LeadBasicInfo = {
  first_name: string
  last_name: string | null
  email: string | null
  phone: string | null
}

export type LenderApplicationRequest = {
  applicant: ApplicantData
  requested_amount: number
  treatment_type?: string
  merchant_id?: string
}

export type LenderApplicationResponse = {
  status: 'approved' | 'denied' | 'pending' | 'error'
  external_id: string | null
  approved_amount?: number
  terms?: ApprovedTerms
  denial_reason_code?: string
  error_message?: string
  raw_response?: Record<string, unknown>
}

export type PaymentEstimate = {
  lender_slug: LenderSlug
  lender_name: string
  monthly_payment: number
  financed_amount: number
  down_payment: number
  apr: number
  term_months: number
  promo_period_months?: number
}

// ── Lender Adapter Interface ────────────────────────────────────

export interface LenderAdapter {
  readonly slug: LenderSlug
  readonly displayName: string
  readonly integrationType: LenderIntegrationType

  /**
   * Submit a full financing application (API-based lenders only).
   * Returns approval/denial/pending status.
   */
  submitApplication?(
    request: LenderApplicationRequest,
    credentials: LenderCredentials
  ): Promise<LenderApplicationResponse>

  /**
   * Check the status of a previously submitted application (API-based lenders only).
   * Used for polling async responses.
   */
  checkStatus?(
    externalId: string,
    credentials: LenderCredentials
  ): Promise<LenderApplicationResponse>

  /**
   * Pre-qualify a lead with a soft credit pull (API-based lenders that support it).
   * Partial applicant data is sufficient.
   */
  preQualify?(
    request: Partial<LenderApplicationRequest>,
    credentials: LenderCredentials
  ): Promise<LenderApplicationResponse>

  /**
   * Generate a patient-facing application URL (link/iframe lenders).
   * The patient completes the application on the lender's platform.
   */
  generateApplicationUrl?(
    leadData: LeadBasicInfo,
    config: LenderConfig
  ): string

  /**
   * Get payment estimates without submitting a full application.
   * Shows "as low as $X/month" in the UI.
   */
  getPaymentEstimate?(
    amount: number,
    config: LenderConfig,
    credentials?: LenderCredentials
  ): Promise<PaymentEstimate[]>

  /**
   * Verify a webhook signature from this lender.
   */
  verifyWebhook?(
    signature: string,
    body: string,
    secret: string
  ): boolean
}
