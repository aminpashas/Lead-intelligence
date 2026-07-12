import type { SupabaseClient } from '@supabase/supabase-js'
import type { CampaignPlaybook } from '@/types/database'

export type CampaignAutopilotMode = 'review_first' | 'auto' | 'off'
export type CampaignSendMode = 'suppressed' | 'live'

export interface CampaignPolicy {
  campaignId: string
  aiEnabled: boolean
  autopilotMode: CampaignAutopilotMode
  sendMode: CampaignSendMode
  playbook: CampaignPlaybook
}

/**
 * The lead's last-touch (most recently enrolled) ACTIVE campaign, with its AI policy.
 * Returns null when the lead is in no active campaign — the default-deny state.
 */
export async function resolveActiveCampaignPolicy(
  supabase: SupabaseClient,
  leadId: string,
  organizationId: string
): Promise<CampaignPolicy | null> {
  const { data, error } = await supabase
    .from('campaign_enrollments')
    .select('campaign_id, created_at, campaign:campaigns(id, ai_enabled, autopilot_mode, send_mode, playbook)')
    .eq('lead_id', leadId)
    .eq('organization_id', organizationId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)

  if (error || !data || data.length === 0) return null
  const c = (data[0] as any).campaign
  if (!c) return null

  return {
    campaignId: c.id,
    aiEnabled: !!c.ai_enabled,
    autopilotMode: (c.autopilot_mode ?? 'review_first') as CampaignAutopilotMode,
    sendMode: (c.send_mode ?? 'suppressed') as CampaignSendMode,
    playbook: (c.playbook ?? {}) as CampaignPlaybook,
  }
}
