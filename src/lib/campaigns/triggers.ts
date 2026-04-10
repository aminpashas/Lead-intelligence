/**
 * Trigger Campaign System
 *
 * Event-based campaign enrollment. When specific events happen
 * (lead created, stage changed, no-show, etc.), matching trigger
 * campaigns automatically enroll the lead.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type TriggerEvent =
  | 'lead_created'
  | 'stage_changed'
  | 'appointment_no_show'
  | 'appointment_scheduled'
  | 'lead_went_cold'
  | 'lead_qualified'
  | 'lead_disqualified'

export type TriggerEventData = {
  event: TriggerEvent
  lead_id: string
  organization_id: string
  metadata?: {
    old_stage?: string
    new_stage?: string
    qualification?: string
    days_inactive?: number
  }
}

/**
 * Process trigger campaigns for a given event.
 * Finds active trigger campaigns matching the event and enrolls the lead.
 */
export async function processTriggerCampaigns(
  supabase: SupabaseClient,
  eventData: TriggerEventData
): Promise<number> {
  // Get all active trigger campaigns for this org
  const { data: triggerCampaigns } = await supabase
    .from('campaigns')
    .select('*, steps:campaign_steps(step_number, delay_minutes)')
    .eq('organization_id', eventData.organization_id)
    .eq('type', 'trigger')
    .eq('status', 'active')

  if (!triggerCampaigns || triggerCampaigns.length === 0) return 0

  let enrolled = 0

  for (const campaign of triggerCampaigns) {
    const criteria = campaign.target_criteria as Record<string, unknown> | null
    if (!criteria) continue

    // Check if this campaign matches the event
    if (!matchesTriggerEvent(criteria, eventData)) continue

    // Check if lead is already enrolled in this campaign
    const { data: existing } = await supabase
      .from('campaign_enrollments')
      .select('id, status')
      .eq('campaign_id', campaign.id)
      .eq('lead_id', eventData.lead_id)
      .single()

    if (existing) {
      // Already enrolled (active or completed) — skip
      if (existing.status === 'active') continue
      // If previously exited/completed, allow re-enrollment for re-engagement campaigns
      if (existing.status !== 'exited' && existing.status !== 'completed') continue
    }

    // Check lead-level criteria (qualification, has_phone, etc.)
    const { data: lead } = await supabase
      .from('leads')
      .select('id, status, ai_qualification, ai_score, phone_formatted, email, sms_consent, sms_opt_out, email_consent, email_opt_out')
      .eq('id', eventData.lead_id)
      .single()

    if (!lead) continue

    // Apply additional filters
    if (criteria.ai_qualification && Array.isArray(criteria.ai_qualification)) {
      if (!criteria.ai_qualification.includes(lead.ai_qualification)) continue
    }
    if (typeof criteria.min_score === 'number' && (lead.ai_score || 0) < criteria.min_score) continue
    if (typeof criteria.max_score === 'number' && (lead.ai_score || 0) > criteria.max_score) continue

    // Check consent
    const channel = campaign.channel as string
    if (channel === 'sms' && (!lead.sms_consent || lead.sms_opt_out)) continue
    if (channel === 'email' && (!lead.email_consent || lead.email_opt_out)) continue
    if (channel === 'sms' && !lead.phone_formatted) continue
    if (channel === 'email' && !lead.email) continue

    // Enroll
    const firstStepDelay = campaign.steps?.[0]?.delay_minutes ?? 0
    const nextStepAt = new Date(Date.now() + firstStepDelay * 60 * 1000).toISOString()

    if (existing) {
      // Re-enroll by updating existing record
      await supabase
        .from('campaign_enrollments')
        .update({
          status: 'active',
          current_step: 0,
          next_step_at: nextStepAt,
          completed_at: null,
          exit_reason: null,
        })
        .eq('id', existing.id)
    } else {
      await supabase
        .from('campaign_enrollments')
        .insert({
          organization_id: eventData.organization_id,
          campaign_id: campaign.id,
          lead_id: eventData.lead_id,
          status: 'active',
          current_step: 0,
          next_step_at: nextStepAt,
        })
    }

    enrolled++

    // Update campaign enrollment count
    await supabase
      .from('campaigns')
      .update({ total_enrolled: (campaign.total_enrolled || 0) + 1 })
      .eq('id', campaign.id)
  }

  return enrolled
}

/**
 * Check if a campaign's target_criteria matches the trigger event.
 */
function matchesTriggerEvent(
  criteria: Record<string, unknown>,
  eventData: TriggerEventData
): boolean {
  const triggerEvent = criteria.trigger_event as string | undefined
  if (!triggerEvent) return false

  // Must match the event type
  if (triggerEvent !== eventData.event) return false

  // For stage_changed, check if the new stage matches
  if (eventData.event === 'stage_changed' && criteria.trigger_stages) {
    const stages = criteria.trigger_stages as string[]
    if (!eventData.metadata?.new_stage || !stages.includes(eventData.metadata.new_stage)) {
      return false
    }
  }

  // For lead_qualified, check qualification level
  if (eventData.event === 'lead_qualified' && criteria.trigger_qualifications) {
    const quals = criteria.trigger_qualifications as string[]
    if (!eventData.metadata?.qualification || !quals.includes(eventData.metadata.qualification)) {
      return false
    }
  }

  return true
}

/**
 * Detect leads that have gone cold (no response in X days).
 * Called by the trigger cron to fire lead_went_cold events.
 */
export async function detectColdLeads(
  supabase: SupabaseClient,
  organizationId: string,
  inactiveDays: number = 7
): Promise<TriggerEventData[]> {
  const cutoffDate = new Date(Date.now() - inactiveDays * 24 * 60 * 60 * 1000).toISOString()

  // Find leads with active conversations but no response in X days
  const { data: coldLeads } = await supabase
    .from('leads')
    .select('id')
    .eq('organization_id', organizationId)
    .not('status', 'in', '("completed","lost","disqualified")')
    .lt('last_responded_at', cutoffDate)
    .gt('last_contacted_at', cutoffDate) // We've reached out but they haven't replied
    .limit(100)

  if (!coldLeads) return []

  return coldLeads.map((lead) => ({
    event: 'lead_went_cold' as TriggerEvent,
    lead_id: lead.id,
    organization_id: organizationId,
    metadata: { days_inactive: inactiveDays },
  }))
}
