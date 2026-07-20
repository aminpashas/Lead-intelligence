import { z } from 'zod'

// Phone format guard: digits plus the usual separators only. Prevents PostgREST
// filter-injection when a phone value is interpolated into a query, and rejects
// obviously malformed input. Kept permissive (international + extensions).
const PHONE_RE = /^[+0-9().\-\s]+$/

export const createLeadSchema = z.object({
  first_name: z.string().min(1, 'First name is required'),
  last_name: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().regex(PHONE_RE, 'Invalid phone number').optional(),

  // Demographics
  city: z.string().optional(),
  state: z.string().optional(),
  zip_code: z.string().optional(),
  age: z.number().optional(),

  // Dental
  dental_condition: z.enum([
    'missing_all_upper', 'missing_all_lower', 'missing_all_both',
    'missing_multiple', 'failing_teeth', 'denture_problems', 'other'
  ]).optional(),
  dental_condition_details: z.string().optional(),
  current_dental_situation: z.string().optional(),
  has_dentures: z.boolean().optional(),
  has_dental_insurance: z.boolean().optional(),
  insurance_provider: z.string().optional(),

  // Financial
  financing_interest: z.enum(['cash_pay', 'financing_needed', 'insurance_only', 'undecided']).optional(),
  budget_range: z.enum(['under_10k', '10k_15k', '15k_20k', '20k_25k', '25k_30k', 'over_30k', 'unknown']).optional(),

  // Source tracking
  source_id: z.string().uuid().optional(),
  source_type: z.string().optional(),
  utm_source: z.string().optional(),
  utm_medium: z.string().optional(),
  utm_campaign: z.string().optional(),
  utm_content: z.string().optional(),
  utm_term: z.string().optional(),
  landing_page_url: z.string().url().optional().or(z.literal('')),
  gclid: z.string().optional(),
  fbclid: z.string().optional(),

  // Assignment
  assigned_to: z.string().uuid().optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().optional(),
})

export const updateLeadSchema = createLeadSchema.partial().extend({
  // Staff editing a lead can also *clear* a contact field. createLeadSchema's
  // phone regex requires at least one character, so an explicit empty-string
  // branch is needed to express "remove this number" (email already has one).
  // The route turns '' into a null column write plus a null search hash.
  phone: z.string().regex(PHONE_RE, 'Invalid phone number').optional().or(z.literal('')),
  status: z.enum([
    'new', 'contacted', 'qualified', 'consultation_scheduled',
    'consultation_completed', 'treatment_presented', 'financing',
    'contract_sent', 'contract_signed', 'scheduled', 'in_treatment',
    'completed', 'lost', 'disqualified', 'no_show', 'unresponsive'
  ]).optional(),
  stage_id: z.string().uuid().optional(),
  disqualified_reason: z.string().optional(),
  lost_reason: z.string().optional(),
  treatment_value: z.number().optional(),
  consultation_date: z.string().optional(),
  consultation_type: z.enum(['in_person', 'virtual', 'phone']).optional(),
  ai_autopilot_override: z.enum(['default', 'force_on', 'force_off', 'assist_only']).optional(),
})

export const webhookLeadSchema = z.object({
  first_name: z.string().optional().default('Unknown'),
  last_name: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().regex(PHONE_RE, 'Invalid phone number').optional(),
  source_type: z.string().optional(),
  utm_source: z.string().optional(),
  utm_medium: z.string().optional(),
  utm_campaign: z.string().optional(),
  utm_content: z.string().optional(),
  utm_term: z.string().optional(),
  gclid: z.string().optional(),
  fbclid: z.string().optional(),
  // Meta cookies captured at form submit (required for CAPI match quality >= 7.0)
  // Forms post these under fbc/fbp (no underscore). Browser cookies are _fbc/_fbp.
  fbc: z.string().optional(),
  fbp: z.string().optional(),
  _fbc: z.string().optional(),
  _fbp: z.string().optional(),
  landing_page_url: z.string().optional(),
  dental_condition: z.string().optional(),
  notes: z.string().optional(),
  custom_fields: z.record(z.string(), z.unknown()).optional(),
  // Explicit consent fields — TCPA requires prior express written consent for marketing SMS
  sms_consent: z.boolean().optional().default(false),
  email_consent: z.boolean().optional().default(false),
})

// ------------------------------------------------------------
// Bulk import — used by /api/leads/import
// ------------------------------------------------------------

/**
 * Per-row schema for bulk import. Adds the consent + audit columns and
 * `do_not_call` so the importer can stamp these from the UI attestation
 * (or per-row override if the CSV carries the data).
 */
export const bulkImportLeadSchema = createLeadSchema.extend({
  // Per-row consent overrides (defaults come from the wrapper payload)
  sms_consent: z.boolean().optional(),
  sms_consent_at: z.string().optional(),
  sms_consent_source: z.string().optional(),
  email_consent: z.boolean().optional(),
  email_consent_at: z.string().optional(),
  email_consent_source: z.string().optional(),
  voice_consent: z.boolean().optional(),
  voice_consent_at: z.string().optional(),
  voice_consent_source: z.string().optional(),
  do_not_call: z.boolean().optional(),
  // Suppression (e.g. imported from a GHL DND export). Opt-out is safety-dominant:
  // when set, it forces the matching channel's consent OFF regardless of any
  // consent value in the same row, so a DND lead can never be messaged.
  sms_opt_out: z.boolean().optional(),
  email_opt_out: z.boolean().optional(),
  /** All-channel do-not-contact (GHL `dnd`) — suppresses sms + email + voice. */
  do_not_contact: z.boolean().optional(),
})

const consentBlockSchema = z.object({
  sms: z.boolean().default(false),
  email: z.boolean().default(false),
  voice: z.boolean().default(false),
  source: z.string().min(1, 'Consent source is required'),
  attested_at: z.string().min(1, 'Attestation timestamp is required'),
}).refine(
  (c) => c.sms || c.email || c.voice,
  { message: 'At least one consent channel must be attested' },
)

const defaultsBlockSchema = z.object({
  source_type: z.string().optional(),
  source_id: z.string().uuid().optional(),
  assigned_to: z.string().uuid().optional(),
  tags: z.array(z.string()).optional(),
  file_name: z.string().optional(),
}).optional().default({})

const postActionsSchema = z.object({
  score: z.boolean().default(true),
  enroll_campaign_id: z.string().uuid().optional(),
}).optional().default({ score: true })

/**
 * Wrapper payload accepted by POST /api/leads/import.
 * The client parses the CSV with papaparse, maps headers to canonical fields,
 * collects consent attestation + import-wide defaults, and posts JSON.
 */
export const bulkImportRequestSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(2000),
  consent: consentBlockSchema,
  defaults: defaultsBlockSchema,
  post_actions: postActionsSchema,
  dedupe: z.enum(['skip', 'overwrite', 'allow']).default('skip'),
})

export type BulkImportLeadInput = z.infer<typeof bulkImportLeadSchema>
export type BulkImportRequest = z.infer<typeof bulkImportRequestSchema>

export type CreateLeadInput = z.infer<typeof createLeadSchema>
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>
export type WebhookLeadInput = z.infer<typeof webhookLeadSchema>
