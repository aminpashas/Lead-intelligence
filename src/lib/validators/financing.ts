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

export const publicFinancingApplicationSchema = financingApplicationSchema.omit({
  lead_id: true,
})

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
