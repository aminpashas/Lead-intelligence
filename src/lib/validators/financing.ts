import { z } from 'zod'

// ── Financing Application Form Schema ──────────────────────────

export const financingApplicationSchema = z.object({
  lead_id: z.string().uuid('Invalid lead ID'),
  first_name: z.string().min(1, 'First name is required'),
  last_name: z.string().min(1, 'Last name is required'),
  date_of_birth: z.string().regex(
    /^\d{4}-\d{2}-\d{2}$/,
    'Date of birth must be YYYY-MM-DD format'
  ).refine((dob) => {
    const date = new Date(dob)
    if (isNaN(date.getTime())) return false
    const now = new Date()
    const age = now.getFullYear() - date.getFullYear()
    return age >= 18 && age <= 100
  }, 'Applicant must be between 18 and 100 years old'),
  ssn: z.string().regex(
    /^\d{9}$/,
    'SSN must be exactly 9 digits with no dashes'
  ).refine((ssn) => {
    // IRS invalid SSN ranges: cannot start with 000, 666, or 9xx
    const area = ssn.substring(0, 3)
    const group = ssn.substring(3, 5)
    const serial = ssn.substring(5, 9)
    if (area === '000' || area === '666' || area[0] === '9') return false
    if (group === '00') return false
    if (serial === '0000') return false
    return true
  }, 'Invalid SSN — please check and re-enter'),
  email: z.string().email('Valid email is required'),
  phone: z.string().regex(/^\d{10,15}$/, 'Phone must be 10-15 digits, numbers only'),
  street_address: z.string().min(1, 'Street address is required'),
  city: z.string().min(1, 'City is required'),
  state: z.string().length(2, 'State must be a 2-letter code'),
  zip_code: z.string().regex(/^\d{5}$/, 'ZIP code must be 5 digits'),
  annual_income: z.number().positive('Annual income must be positive').max(10_000_000, 'Income value seems incorrect'),
  employment_status: z.enum(
    ['employed', 'self_employed', 'retired', 'other'],
  ),
  employer_name: z.string().optional(),
  requested_amount: z.number().positive('Requested amount must be positive').max(250_000, 'Maximum financing amount is $250,000'),
  consent_given: z.literal(true),
})

export type FinancingApplicationInput = z.infer<typeof financingApplicationSchema>

// ── Public Form Schema (via share token — no lead_id required) ──
//
// The public form supports a "substitute applicant": a family member or friend
// applying on the patient's behalf. When applicant_type is 'on_behalf', the
// applicant fields above describe the substitute (the borrower being credit
// checked) and applicant_relationship is required.

export const applicantRelationshipEnum = z.enum([
  'spouse',
  'parent',
  'adult_child',
  'other_family',
  'friend',
  'other',
])

export const publicFinancingApplicationSchema = financingApplicationSchema
  .omit({ lead_id: true })
  .extend({
    applicant_type: z.enum(['self', 'on_behalf']).default('self'),
    applicant_relationship: applicantRelationshipEnum.optional(),
  })
  .refine(
    (d) => d.applicant_type !== 'on_behalf' || !!d.applicant_relationship,
    { message: 'Relationship to the patient is required when applying on their behalf', path: ['applicant_relationship'] }
  )

export type PublicFinancingApplicationInput = z.infer<typeof publicFinancingApplicationSchema>

// ── Lender Config Schema ────────────────────────────────────────

export const lenderConfigSchema = z.object({
  lender_slug: z.enum(['carecredit', 'sunbit', 'proceed', 'lendingclub', 'cherry', 'alpheon', 'affirm']),
  is_active: z.boolean(),
  priority_order: z.number().int().positive(),
  credentials: z.record(z.string(), z.string()).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
})

export type LenderConfigInput = z.infer<typeof lenderConfigSchema>

export const updateLenderConfigsSchema = z.object({
  lenders: z.array(lenderConfigSchema).min(1).max(10),
})

export type UpdateLenderConfigsInput = z.infer<typeof updateLenderConfigsSchema>

// ── Payment Estimate Schema ─────────────────────────────────────

export const paymentEstimateRequestSchema = z.object({
  amount: z.number().positive('Amount must be positive'),
  lead_id: z.string().uuid().optional(),
})

export type PaymentEstimateRequestInput = z.infer<typeof paymentEstimateRequestSchema>

// ── Collect-All Prequalification Request ────────────────────────

export const prequalRequestSchema = z.object({
  lead_id: z.string().uuid(),
  amount: z.number().positive('Amount must be positive').max(250_000, 'Maximum financing amount is $250,000'),
})

export type PrequalRequestInput = z.infer<typeof prequalRequestSchema>

// ── Checkout (stacked plan) Schemas ─────────────────────────────

const lenderTermOptionSchema = z.object({
  apr: z.number(),
  term_months: z.number().int().positive(),
  promo_period_months: z.number().int().min(0),
})

export const checkoutCreateSchema = z.object({
  lead_id: z.string().uuid(),
  treatment_total: z.number().positive().max(250_000),
  selections: z.array(z.object({
    lender_slug: z.string().min(1),
    lender_name: z.string().min(1),
    requested_amount: z.number().positive(),
    term: lenderTermOptionSchema,
    application_url: z.string().url().optional(),
  })).min(1).max(10),
})
export type CheckoutCreateInput = z.infer<typeof checkoutCreateSchema>

export const checkoutReconcileSchema = z.object({
  lender_slug: z.string().min(1),
  status: z.enum(['selected', 'link_sent', 'started', 'approved', 'funded', 'declined', 'expired']),
  funded_amount: z.number().min(0).optional(),
  confirmed_by: z.enum(['staff', 'patient', 'webhook']).optional(),
})
export type CheckoutReconcileInput = z.infer<typeof checkoutReconcileSchema>

// ── Webhook Payload Schemas (per lender) ────────────────────────

export const financingWebhookBaseSchema = z.object({
  external_application_id: z.string(),
  status: z.enum(['approved', 'denied', 'pending', 'error']),
  approved_amount: z.number().optional(),
  terms: z.object({
    apr: z.number(),
    term_months: z.number(),
    monthly_payment: z.number(),
    promo_period_months: z.number().optional(),
  }).optional(),
  denial_reason_code: z.string().optional(),
  error_message: z.string().optional(),
})

export type FinancingWebhookPayload = z.infer<typeof financingWebhookBaseSchema>
