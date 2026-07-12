import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveActiveCampaignPolicy } from './policy'

const AUTOMATION_CALLER_PREFIXES = ['autopilot.', 'campaign.']

/** Automation-origin sends are campaign-gated; human staff sends are never gated (spec D5). */
export function isAutomationCaller(caller?: string): boolean {
  if (!caller) return false
  return AUTOMATION_CALLER_PREFIXES.some((p) => caller.startsWith(p))
}

export type CampaignSendDecision =
  | { allowed: true }
  | { allowed: false; reason: 'no_active_campaign' | 'send_suppressed' }

/**
 * Deny-by-default authorization for AUTOMATION sends. A human-initiated send
 * (no automation caller) is always allowed. An automation send is allowed only
 * when the lead's last-touch active campaign has send_mode='live'.
 */
export async function assertCampaignSendAllowed(
  supabase: SupabaseClient,
  params: { leadId: string; caller?: string }
): Promise<CampaignSendDecision> {
  if (!isAutomationCaller(params.caller)) return { allowed: true }

  const { data: lead } = await supabase
    .from('leads')
    .select('organization_id')
    .eq('id', params.leadId)
    .single()
  if (!lead) return { allowed: false, reason: 'no_active_campaign' }

  const policy = await resolveActiveCampaignPolicy(supabase, params.leadId, (lead as any).organization_id)
  if (!policy) return { allowed: false, reason: 'no_active_campaign' }
  if (policy.sendMode !== 'live') return { allowed: false, reason: 'send_suppressed' }
  return { allowed: true }
}
