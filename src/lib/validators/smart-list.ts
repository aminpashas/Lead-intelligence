import { z } from 'zod'

export const KEYWORD_SCOPES = ['conversation', 'lead_fields', 'inbound_sms', 'tags'] as const

// Canonical enums for the compact conversation-analysis fields on leads.
// The sweep cron writes these values; smart lists filter on them. Keep in sync
// with the ConversationIntent/ConversationSentiment/PrimaryObjection types in
// src/types/database.ts and the prompt in src/lib/ai/conversation-sweep.ts.
export const CONVERSATION_INTENTS = [
  'ready_to_book', 'considering', 'exploring', 'resistant', 'disengaged',
] as const

export const CONVERSATION_SENTIMENTS = ['positive', 'neutral', 'mixed', 'negative'] as const

export const PRIMARY_OBJECTIONS = [
  'cost', 'financing', 'fear_anxiety', 'timing', 'trust',
  'medical', 'logistics', 'spouse_approval', 'none', 'other',
] as const

export const smartListCriteriaSchema = z.object({
  tags: z.object({
    ids: z.array(z.string().uuid()),
    operator: z.enum(['and', 'or']),
  }).optional(),
  statuses: z.array(z.string()).optional(),
  ai_qualifications: z.array(z.string()).optional(),
  conversation_intents: z.array(z.enum(CONVERSATION_INTENTS)).optional(),
  conversation_sentiments: z.array(z.enum(CONVERSATION_SENTIMENTS)).optional(),
  primary_objections: z.array(z.enum(PRIMARY_OBJECTIONS)).optional(),
  conversation_red_flag: z.boolean().optional(),
  score_min: z.number().min(0).max(100).optional(),
  score_max: z.number().min(0).max(100).optional(),
  stages: z.array(z.string().uuid()).optional(),
  source_types: z.array(z.string()).optional(),
  engagement_min: z.number().optional(),
  engagement_max: z.number().optional(),
  states: z.array(z.string()).optional(),
  created_after: z.string().optional(),
  created_before: z.string().optional(),
  /** Leads whose last contact is older than this ISO datetime OR who have never
   *  been contacted (last_contacted_at is null — maximally stale). Powers the
   *  "needs follow-up" segments used by the Pipeline recommendations engine. */
  last_contacted_before: z.string().optional(),
  /** Only leads that have never been contacted (last_contacted_at is null). */
  never_contacted: z.boolean().optional(),
  /** Closer workflow temperature(s), e.g. ['deliberating']. */
  closing_temperatures: z.array(z.string()).optional(),
  /** Deliberating deals whose follow-up date has arrived (non-null and <= this). */
  closing_follow_up_before: z.string().optional(),
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
