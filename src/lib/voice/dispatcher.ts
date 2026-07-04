/**
 * Live-Transfer Dispatcher.
 *
 * One tick = for each org with live transfer armed, dial as many queued campaign
 * leads as we can currently hand off to a human. Called by the cron route.
 *
 * Safety properties:
 *  • Only dials when BOTH org.voice_enabled AND org.voice_live_transfer_enabled.
 *  • Every dial still passes preCallCheck (TCPA window, DNC, consent, rate limit).
 *  • Rep capacity is a single shared pool per org — consumed as we dial across
 *    campaigns so two campaigns can't double-commit the same staff.
 *  • Reaps stale on_call locks so a missed call-ended webhook can't wedge a rep
 *    as permanently busy.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { checkSendWindow } from '@/lib/campaigns/send-window'
import { resolveTransferCandidates, computeDialBatchSize } from '@/lib/voice/transfer-routing'
import {
  loadActiveRoutes,
  ensurePresenceForOrg,
  countAvailableReps,
} from '@/lib/voice/transfer-presence'
import { preCallCheck, initiateOutboundCall } from '@/lib/voice/call-manager'
import { logger } from '@/lib/logger'
import type { VoiceCampaign } from '@/types/database'

const DAY_NAME_TO_NUM: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
}

export type DispatchResult = {
  organizations: number
  campaignsProcessed: number
  dialed: number
  skipped: number
  repsReaped: number
}

/**
 * Release presence rows stuck 'on_call' longer than any real call could last.
 * The primary release path is the call_ended webhook; this is the backstop for a
 * dropped/late webhook so capacity always recovers.
 */
async function reapStaleReps(
  supabase: SupabaseClient,
  organizationId: string,
  maxCallSeconds: number
): Promise<number> {
  const cutoff = new Date(Date.now() - (maxCallSeconds + 120) * 1000).toISOString()
  const { data: stale } = await supabase
    .from('voice_agent_presence')
    .select('target_id')
    .eq('organization_id', organizationId)
    .eq('status', 'on_call')
    .lt('updated_at', cutoff)

  if (!stale || stale.length === 0) return 0
  for (const row of stale) {
    await supabase.rpc('release_transfer_target', { p_target_id: row.target_id })
  }
  logger.warn('Reaped stale on_call reps', { organizationId, count: stale.length })
  return stale.length
}

/** Is a live-transfer campaign currently within its own active window? */
function campaignInWindow(campaign: VoiceCampaign, now: Date): boolean {
  const days = (campaign.active_days || []).map(d => DAY_NAME_TO_NUM[d.toLowerCase()])
  return checkSendWindow(
    {
      start_hour: campaign.active_hours_start,
      end_hour: campaign.active_hours_end,
      timezone: campaign.timezone,
      days,
    },
    now
  ).allowed
}

/** Dispatch one org. Mutates nothing outside the DB; returns per-org tallies. */
async function dispatchOrg(
  supabase: SupabaseClient,
  org: { id: string; voice_max_call_duration_seconds: number | null; voice_max_outbound_per_hour: number | null },
  now: Date
): Promise<{ campaignsProcessed: number; dialed: number; skipped: number; repsReaped: number }> {
  const orgId = org.id
  let dialed = 0
  let skipped = 0
  let campaignsProcessed = 0

  const repsReaped = await reapStaleReps(supabase, orgId, org.voice_max_call_duration_seconds || 600)
  await ensurePresenceForOrg(supabase, orgId)

  // Reps that could take a call right now = everyone reachable via the current
  // routing window (primary + overflow). This is the shared pool for the org.
  const routes = await loadActiveRoutes(supabase, orgId)
  const { primary, overflow } = resolveTransferCandidates(routes, now)
  const candidateIds = [...new Set([...primary, ...overflow])]
  let availableReps = await countAvailableReps(supabase, orgId, candidateIds)

  if (availableReps <= 0) {
    // No one to hand off to → don't originate anything (would strand callers on hold).
    return { campaignsProcessed: 0, dialed: 0, skipped: 0, repsReaped }
  }

  // Remaining hourly budget (preCallCheck also enforces this, but computing it
  // here avoids pulling leads we'd only get rejected on).
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString()
  const { count: sentThisHour } = await supabase
    .from('voice_calls')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId)
    .eq('direction', 'outbound')
    .gte('created_at', oneHourAgo)
  let hourlyRemaining = Math.max((org.voice_max_outbound_per_hour || 20) - (sentThisHour || 0), 0)

  const { data: campaigns } = await supabase
    .from('voice_campaigns')
    .select('*')
    .eq('organization_id', orgId)
    .eq('status', 'active')
    .eq('live_transfer_enabled', true)

  for (const campaign of (campaigns as VoiceCampaign[]) || []) {
    if (availableReps <= 0 || hourlyRemaining <= 0) break
    if (!campaignInWindow(campaign, now)) continue
    campaignsProcessed++

    // In-flight = leads currently being called for this campaign.
    const { count: inFlight } = await supabase
      .from('voice_campaign_leads')
      .select('id', { count: 'exact', head: true })
      .eq('voice_campaign_id', campaign.id)
      .eq('status', 'calling')

    const batch = computeDialBatchSize({
      availableReps,
      dialRatio: campaign.dial_ratio || 1.0,
      inFlightCalls: inFlight || 0,
      maxThisTick: hourlyRemaining,
    })
    if (batch <= 0) continue

    // Pull the next queued leads (highest priority first).
    const { data: queued } = await supabase
      .from('voice_campaign_leads')
      .select('id, lead_id, attempts')
      .eq('voice_campaign_id', campaign.id)
      .eq('status', 'queued')
      .order('priority', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(batch)

    for (const cl of queued || []) {
      if (availableReps <= 0 || hourlyRemaining <= 0) break

      const check = await preCallCheck(supabase, cl.lead_id, orgId)
      if (!check.allowed) {
        // DNC/opt-out are terminal for this lead; transient reasons just skip.
        const terminal = ['do_not_call_flagged', 'voice_opt_out', 'no_consent', 'invalid_phone_format', 'no_phone_number']
        await supabase
          .from('voice_campaign_leads')
          .update({
            status: terminal.includes(check.reason || '') ? 'skipped' : 'queued',
            last_attempt_at: new Date().toISOString(),
            outcome: check.reason,
          })
          .eq('id', cl.id)
        skipped++
        continue
      }

      const { data: lead } = await supabase
        .from('leads')
        .select('first_name, last_name')
        .eq('id', cl.lead_id)
        .maybeSingle()

      const res = await initiateOutboundCall(supabase, {
        organization_id: orgId,
        lead_id: cl.lead_id,
        lead: lead || {},
        phone: check.phone!,
        voice_campaign_id: campaign.id,
        agent_type: campaign.agent_type,
        live_transfer: true,
        transfer_mode: campaign.transfer_mode,
      })

      if ('error' in res) {
        skipped++
        continue
      }

      await supabase
        .from('voice_campaign_leads')
        .update({
          status: 'calling',
          last_attempt_at: new Date().toISOString(),
          last_call_id: res.call_id,
          attempts: (cl.attempts || 0) + 1,
        })
        .eq('id', cl.id)

      dialed++
      availableReps--   // consume the shared org pool
      hourlyRemaining--
    }
  }

  return { campaignsProcessed, dialed, skipped, repsReaped }
}

/** Run a full dispatch tick across all armed orgs. */
export async function runDispatchTick(supabase: SupabaseClient, now: Date = new Date()): Promise<DispatchResult> {
  const { data: orgs } = await supabase
    .from('organizations')
    .select('id, voice_max_call_duration_seconds, voice_max_outbound_per_hour')
    .eq('voice_enabled', true)
    .eq('voice_live_transfer_enabled', true)

  const result: DispatchResult = {
    organizations: 0,
    campaignsProcessed: 0,
    dialed: 0,
    skipped: 0,
    repsReaped: 0,
  }

  for (const org of orgs || []) {
    result.organizations++
    try {
      const r = await dispatchOrg(supabase, org, now)
      result.campaignsProcessed += r.campaignsProcessed
      result.dialed += r.dialed
      result.skipped += r.skipped
      result.repsReaped += r.repsReaped
    } catch (error) {
      logger.error('Dispatch failed for org', { orgId: org.id }, error instanceof Error ? error : undefined)
    }
  }

  return result
}
