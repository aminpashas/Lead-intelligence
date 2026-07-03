import { z } from 'zod'

export const KEYWORD_SCOPES = ['conversation', 'lead_fields', 'inbound_sms', 'tags'] as const

export const smartListCriteriaSchema = z.object({
  tags: z.object({
    ids: z.array(z.string().uuid()),
    operator: z.enum(['and', 'or']),
  }).optional(),
  statuses: z.array(z.string()).optional(),
  ai_qualifications: z.array(z.string()).optional(),
  score_min: z.number().min(0).max(100).optional(),
  score_max: z.number().min(0).max(100).optional(),
  stages: z.array(z.string().uuid()).optional(),
  source_types: z.array(z.string()).optional(),
  engagement_min: z.number().optional(),
  engagement_max: z.number().optional(),
  states: z.array(z.string()).optional(),
  created_after: z.string().optional(),
  created_before: z.string().optional(),
  has_phone: z.boolean().optional(),
  has_email: z.boolean().optional(),
  sms_consent: z.boolean().optional(),
  email_consent: z.boolean().optional(),
  is_existing_patient: z.boolean().optional(),
  keywords: z.object({
    terms: z.array(z.string().trim().min(1).max(80)).min(1).max(10),
    match: z.enum(['any', 'all']),
    scopes: z.array(z.enum(KEYWORD_SCOPES)).min(1),
  }).optional(),
})
