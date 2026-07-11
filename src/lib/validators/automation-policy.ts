import { z } from 'zod'

export const automationPolicyInput = z.object({
  scope: z.enum(['campaign', 'stage']),
  campaign_id: z.string().uuid().nullable().optional(),
  voice_campaign_id: z.string().uuid().nullable().optional(),
  stage_id: z.string().uuid().nullable().optional(),
  kinds: z.array(z.enum(['inbound_reply', 'speed_to_lead', 'nurture_step'])).min(1),
  owner: z.enum(['ai', 'human', 'hybrid']),
  human_schedule: z.record(z.string(), z.unknown()).nullable().optional(),
  human_first: z.boolean().optional(),
  human_response_sla_seconds: z.number().int().min(30).max(3600).optional(),
  confidence_threshold: z.number().min(0).max(1).nullable().optional(),
  active_hours_start: z.number().int().min(0).max(23).nullable().optional(),
  active_hours_end: z.number().int().min(1).max(24).nullable().optional(),
  enabled: z.boolean().optional(),
}).refine(
  (d) => (d.scope === 'campaign' ? !!(d.campaign_id || d.voice_campaign_id) : !!d.stage_id),
  { message: 'scope target id is required for the chosen scope' }
).refine(
  (d) => d.active_hours_start == null || d.active_hours_end == null || d.active_hours_start < d.active_hours_end,
  { message: 'active_hours_start must be < active_hours_end' }
)

export type AutomationPolicyInput = z.infer<typeof automationPolicyInput>
