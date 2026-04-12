/**
 * Campaign Dialer — Outbound Voice Campaign Scheduler
 *
 * Manages automated outbound calling campaigns:
 * - Pulls leads from voice campaign queues
 * - Respects schedule (active hours, days, timezone)
 * - TCPA consent gating before every dial
 * - Rate limiting (calls per hour, concurrent calls)
 * - Retry logic (max attempts, cooldown between retries)
 * - Voicemail detection handling
 *
 * This module is designed to be called by a cron job or
 * manual trigger via the campaign management API.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { preCallCheck, initiateOutboundCall } from './call-manager'
import { logger } from '@/lib/logger'
import type { VoiceCampaignLeadStatus } from '@/types/database'

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export type DialerResult = {
  campaign_id: string
  leads_processed: number
  calls_initiated: number
  calls_skipped: number
  calls_failed: number
  reasons: Record<string, number> // Reason → count
}

// ═══════════════════════════════════════════════════════════════
// MAIN DIALER LOOP
// ═══════════════════════════════════════════════════════════════

/**
 * Process the next batch of leads for an active voice campaign.
 * Called periodically by a cron job or manual trigger.
 *
 * Batch size is limited by concurrent_calls and calls_per_hour settings.
 */
export async function processVoiceCampaign(
  supabase: SupabaseClient,
  campaignId: string
): Promise<DialerResult> {
  const result: DialerResult = {
    campaign_id: campaignId,
    leads_processed: 0,
    calls_initiated: 0,
    calls_skipped: 0,
    calls_failed: 0,
    reasons: {},
  }

  // 1. Load campaign config
  const { data: campaign } = await supabase
    .from('voice_campaigns')
    .select('*')
    .eq('id', campaignId)
    .single()

  if (!campaign) {
    logger.error('Voice campaign not found', { campaignId })
    return result
  }

  if (campaign.status !== 'active') {
    logger.info('Voice campaign not active, skipping', { campaignId, status: campaign.status })
    return result
  }

  // 2. Check schedule — is it the right time to call?
  if (!isWithinSchedule(campaign)) {
    logger.info('Voice campaign outside active hours', { campaignId })
    return result
  }

  // 3. Check rate limit — how many more calls can we make?
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { count: recentCallCount } = await supabase
    .from('voice_calls')
    .select('id', { count: 'exact', head: true })
    .eq('voice_campaign_id', campaignId)
    .gte('created_at', oneHourAgo)

  const remainingBudget = Math.max(0, (campaign.calls_per_hour || 20) - (recentCallCount || 0))
  if (remainingBudget === 0) {
    logger.info('Voice campaign hourly limit reached', { campaignId })
    return result
  }

  // 4. Check active calls — respect concurrent limit
  const { count: activeCalls } = await supabase
    .from('voice_calls')
    .select('id', { count: 'exact', head: true })
    .eq('voice_campaign_id', campaignId)
    .in('status', ['initiated', 'ringing', 'in_progress'])

  const concurrentSlots = Math.max(0, (campaign.concurrent_calls || 1) - (activeCalls || 0))
  if (concurrentSlots === 0) {
    logger.info('Voice campaign max concurrent calls reached', { campaignId })
    return result
  }

  // 5. Pull next batch of leads to call
  const batchSize = Math.min(remainingBudget, concurrentSlots, 10) // Max 10 per batch
  const { data: queuedLeads } = await supabase
    .from('voice_campaign_leads')
    .select('*, lead:leads(*)')
    .eq('voice_campaign_id', campaignId)
    .eq('status', 'queued')
    .lt('attempts', campaign.max_attempts_per_lead || 3)
    .order('priority', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(batchSize)

  if (!queuedLeads || queuedLeads.length === 0) {
    logger.info('Voice campaign queue empty', { campaignId })

    // Check if all leads are processed → mark campaign complete
    const { count: remainingQueued } = await supabase
      .from('voice_campaign_leads')
      .select('id', { count: 'exact', head: true })
      .eq('voice_campaign_id', campaignId)
      .eq('status', 'queued')

    if (remainingQueued === 0) {
      await supabase
        .from('voice_campaigns')
        .update({ status: 'completed' })
        .eq('id', campaignId)
      logger.info('Voice campaign completed — all leads processed', { campaignId })
    }

    return result
  }

  // 6. Process each lead
  for (const queuedLead of queuedLeads) {
    result.leads_processed++

    // Check retry cooldown
    if (queuedLead.last_attempt_at) {
      const lastAttempt = new Date(queuedLead.last_attempt_at)
      const cooldownMs = (campaign.retry_delay_hours || 24) * 60 * 60 * 1000
      if (Date.now() - lastAttempt.getTime() < cooldownMs) {
        result.calls_skipped++
        addReason(result.reasons, 'retry_cooldown')
        continue
      }
    }

    // Pre-call TCPA check
    const check = await preCallCheck(supabase, queuedLead.lead_id, campaign.organization_id)

    if (!check.allowed) {
      // Mark lead as skipped or DNC
      const newStatus: VoiceCampaignLeadStatus = check.reason === 'do_not_call_flagged' ? 'do_not_call' : 'skipped'
      await supabase
        .from('voice_campaign_leads')
        .update({ status: newStatus, outcome: check.reason })
        .eq('id', queuedLead.id)

      result.calls_skipped++
      addReason(result.reasons, check.reason || 'unknown')
      continue
    }

    // Mark as calling
    await supabase
      .from('voice_campaign_leads')
      .update({
        status: 'calling' as VoiceCampaignLeadStatus,
        attempts: (queuedLead.attempts || 0) + 1,
        last_attempt_at: new Date().toISOString(),
      })
      .eq('id', queuedLead.id)

    // Initiate the call
    const callResult = await initiateOutboundCall(supabase, {
      organization_id: campaign.organization_id,
      lead_id: queuedLead.lead_id,
      lead: queuedLead.lead || {},
      phone: check.phone!,
      voice_campaign_id: campaignId,
      agent_type: campaign.agent_type || 'setter',
    })

    if ('error' in callResult) {
      // Call failed to initiate
      const reachedMaxAttempts = (queuedLead.attempts || 0) + 1 >= (campaign.max_attempts_per_lead || 3)

      await supabase
        .from('voice_campaign_leads')
        .update({
          status: reachedMaxAttempts ? 'failed' : 'queued', // Re-queue for retry
          outcome: callResult.error,
          last_call_id: null,
        })
        .eq('id', queuedLead.id)

      result.calls_failed++
      addReason(result.reasons, 'initiation_failed')
    } else {
      // Call initiated successfully
      await supabase
        .from('voice_campaign_leads')
        .update({ last_call_id: callResult.call_id })
        .eq('id', queuedLead.id)

      result.calls_initiated++
    }

    // Small delay between calls to avoid overwhelming the system
    await sleep(2000)
  }

  logger.info('Voice campaign batch processed', {
    campaignId,
    ...result,
  })

  return result
}

// ═══════════════════════════════════════════════════════════════
// CAMPAIGN QUEUE MANAGEMENT
// ═══════════════════════════════════════════════════════════════

/**
 * Populate a campaign's dial queue from a smart list or criteria.
 */
export async function populateCampaignQueue(
  supabase: SupabaseClient,
  campaignId: string
): Promise<{ leads_added: number }> {
  const { data: campaign } = await supabase
    .from('voice_campaigns')
    .select('organization_id, smart_list_id, target_criteria')
    .eq('id', campaignId)
    .single()

  if (!campaign) return { leads_added: 0 }

  // Build lead query
  let query = supabase
    .from('leads')
    .select('id')
    .eq('organization_id', campaign.organization_id)
    .eq('do_not_call', false)
    .eq('voice_opt_out', false)
    .not('phone_formatted', 'is', null)

  // Apply smart list criteria if available
  if (campaign.smart_list_id) {
    const { data: smartList } = await supabase
      .from('smart_lists')
      .select('criteria')
      .eq('id', campaign.smart_list_id)
      .single()

    if (smartList?.criteria) {
      const criteria = smartList.criteria as Record<string, unknown>

      if (criteria.statuses && Array.isArray(criteria.statuses)) {
        query = query.in('status', criteria.statuses as string[])
      }
      if (criteria.ai_qualifications && Array.isArray(criteria.ai_qualifications)) {
        query = query.in('ai_qualification', criteria.ai_qualifications as string[])
      }
      if (criteria.score_min !== undefined) {
        query = query.gte('ai_score', criteria.score_min as number)
      }
      if (criteria.has_phone) {
        query = query.not('phone_formatted', 'is', null)
      }
    }
  }

  const { data: leads } = await query.limit(1000)

  if (!leads || leads.length === 0) return { leads_added: 0 }

  // Exclude leads already in this campaign
  const { data: existingLeads } = await supabase
    .from('voice_campaign_leads')
    .select('lead_id')
    .eq('voice_campaign_id', campaignId)

  const existingLeadIds = new Set((existingLeads || []).map(l => l.lead_id))
  const newLeads = leads.filter(l => !existingLeadIds.has(l.id))

  if (newLeads.length === 0) return { leads_added: 0 }

  // Insert into queue
  const queueEntries = newLeads.map((lead, index) => ({
    voice_campaign_id: campaignId,
    lead_id: lead.id,
    organization_id: campaign.organization_id,
    status: 'queued' as VoiceCampaignLeadStatus,
    priority: index, // Higher priority = called first
  }))

  // Insert in batches of 100
  let totalAdded = 0
  for (let i = 0; i < queueEntries.length; i += 100) {
    const batch = queueEntries.slice(i, i + 100)
    const { error } = await supabase.from('voice_campaign_leads').insert(batch)
    if (!error) totalAdded += batch.length
  }

  // Update campaign total
  await supabase
    .from('voice_campaigns')
    .update({ total_leads: (existingLeadIds.size || 0) + totalAdded })
    .eq('id', campaignId)

  logger.info('Campaign queue populated', { campaignId, leads_added: totalAdded })
  return { leads_added: totalAdded }
}

/**
 * Update a campaign queue lead's status after a call ends.
 */
export async function updateCampaignLeadAfterCall(
  supabase: SupabaseClient,
  campaignId: string,
  leadId: string,
  outcome: string | null,
  maxAttempts: number
): Promise<void> {
  // Determine final status
  const { data: queueLead } = await supabase
    .from('voice_campaign_leads')
    .select('attempts')
    .eq('voice_campaign_id', campaignId)
    .eq('lead_id', leadId)
    .single()

  if (!queueLead) return

  let newStatus: VoiceCampaignLeadStatus = 'completed'

  // Re-queue for retry if not connected and attempts remaining
  const retryableOutcomes = ['no_answer', 'busy', 'voicemail_left', 'technical_failure']
  if (outcome && retryableOutcomes.includes(outcome) && (queueLead.attempts || 0) < maxAttempts) {
    newStatus = 'queued'
  }

  if (outcome === 'do_not_call') {
    newStatus = 'do_not_call'
  }

  await supabase
    .from('voice_campaign_leads')
    .update({ status: newStatus, outcome })
    .eq('voice_campaign_id', campaignId)
    .eq('lead_id', leadId)
}

// ═══════════════════════════════════════════════════════════════
// SCHEDULE HELPERS
// ═══════════════════════════════════════════════════════════════

/**
 * Check if the current time is within the campaign's active schedule.
 */
function isWithinSchedule(campaign: Record<string, unknown>): boolean {
  const now = new Date()

  // Get current time in campaign's timezone
  const timezone = (campaign.timezone as string) || 'America/New_York'
  let currentHour: number
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    })
    currentHour = parseInt(formatter.format(now))
  } catch {
    currentHour = now.getHours()
  }

  // Check active hours
  const startHour = (campaign.active_hours_start as number) ?? 9
  const endHour = (campaign.active_hours_end as number) ?? 18

  if (currentHour < startHour || currentHour >= endHour) {
    return false
  }

  // Check active days
  const activeDays = (campaign.active_days as string[]) || ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

  let currentDayIndex: number
  try {
    const dayFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long',
    })
    const dayName = dayFormatter.format(now).toLowerCase()
    currentDayIndex = dayNames.indexOf(dayName)
  } catch {
    currentDayIndex = now.getDay()
  }

  const currentDay = dayNames[currentDayIndex]
  return activeDays.includes(currentDay)
}

// ═══════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════

function addReason(reasons: Record<string, number>, reason: string): void {
  reasons[reason] = (reasons[reason] || 0) + 1
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
