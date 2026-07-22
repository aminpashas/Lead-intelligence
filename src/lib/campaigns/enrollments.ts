import type { SupabaseClient } from '@supabase/supabase-js'
import type { SmartListCriteria } from '@/types/database'
import { computeReplyStepIncrements } from './reply-attribution'
import { resolveSmartListLeads } from './smart-list-resolver'

// ════════════════════════════════════════════════════════════════
// CAMPAIGN EXIT ON REPLY
// ════════════════════════════════════════════════════════════════

/**
 * When a lead replies via SMS/email, exit any active campaign enrollments
 * that have an if_replied exit condition. Also updates lead engagement stats.
 */
export async function exitCampaignsOnReply(
  supabase: SupabaseClient,
  leadId: string,
  organizationId: string
): Promise<number> {
  // Get all active enrollments for this lead
  const { data: activeEnrollments } = await supabase
    .from('campaign_enrollments')
    .select('id, campaign_id, current_step')
    .eq('lead_id', leadId)
    .eq('organization_id', organizationId)
    .eq('status', 'active')

  if (!activeEnrollments || activeEnrollments.length === 0) return 0

  // Batch load ALL campaign steps for all relevant campaigns in ONE query (fixes N+1)
  const campaignIds = [...new Set(activeEnrollments.map((e) => e.campaign_id))]
  const { data: allSteps } = await supabase
    .from('campaign_steps')
    .select('id, campaign_id, step_number, exit_condition, total_replied')
    .in('campaign_id', campaignIds)

  // Find enrollments whose campaigns have if_replied exit conditions
  const enrollmentIdsToExit: string[] = []

  for (const enrollment of activeEnrollments) {
    const relevantSteps = (allSteps || []).filter(
      (s) => s.campaign_id === enrollment.campaign_id && s.step_number >= (enrollment.current_step || 0)
    )

    const hasReplyExit = relevantSteps.some((s) => {
      if (!s.exit_condition) return false
      const condition = typeof s.exit_condition === 'string'
        ? s.exit_condition
        : (s.exit_condition as Record<string, unknown>)?.type
      return condition === 'if_replied'
    })

    if (hasReplyExit) {
      enrollmentIdsToExit.push(enrollment.id)
    }
  }

  // Batch exit all matching enrollments in ONE query
  let exited = 0
  if (enrollmentIdsToExit.length > 0) {
    const { data } = await supabase
      .from('campaign_enrollments')
      .update({
        status: 'exited',
        completed_at: new Date().toISOString(),
        exit_reason: 'Lead replied to conversation',
      })
      .in('id', enrollmentIdsToExit)
      .select('id')
    exited = data?.length || 0
  }

  // Attribute the reply to campaign_steps.total_replied — but only on the
  // lead's FIRST reply, so a chatty lead can't inflate the counter. We read
  // last_responded_at before setting it below to detect the first reply.
  const { data: leadRow } = await supabase
    .from('leads')
    .select('last_responded_at')
    .eq('id', leadId)
    .maybeSingle<{ last_responded_at: string | null }>()

  if (!leadRow?.last_responded_at && allSteps) {
    const increments = computeReplyStepIncrements(
      activeEnrollments.map((e) => ({ campaign_id: e.campaign_id, current_step: e.current_step })),
      allSteps as Array<{ id: string; campaign_id: string; step_number: number; total_replied: number | null }>
    )
    for (const inc of increments) {
      await supabase.from('campaign_steps').update({ total_replied: inc.total_replied }).eq('id', inc.id)
    }
  }

  // Update lead engagement stats
  await supabase
    .from('leads')
    .update({
      last_responded_at: new Date().toISOString(),
    })
    .eq('id', leadId)

  return exited
}

/**
 * Exit ALL active campaign enrollments for a lead (used on disqualify/lost).
 */
export async function exitAllCampaigns(
  supabase: SupabaseClient,
  leadId: string,
  reason: string
): Promise<number> {
  const { data } = await supabase
    .from('campaign_enrollments')
    .update({
      status: 'exited',
      completed_at: new Date().toISOString(),
      exit_reason: reason,
    })
    .eq('lead_id', leadId)
    .eq('status', 'active')
    .select('id')

  return data?.length || 0
}

// ════════════════════════════════════════════════════════════════
// AUTO-ENROLLMENT
// ════════════════════════════════════════════════════════════════

/** Legacy `target_criteria` used flat, singular keys that predate SmartListCriteria.
 *  These map onto the modern plural-key shape the shared resolver understands. */
const SMART_LIST_KEYS = [
  'tags', 'statuses', 'ai_qualifications', 'conversation_intents',
  'conversation_sentiments', 'primary_objections', 'conversation_red_flag',
  'score_min', 'score_max', 'stages', 'service_line', 'source_types',
  'engagement_min', 'engagement_max', 'states', 'created_after', 'created_before',
  'last_contacted_before', 'closing_temperatures', 'closing_follow_up_before',
  'never_contacted', 'has_phone', 'has_email', 'sms_consent', 'email_consent',
  'is_existing_patient', 'keywords',
] as const

/**
 * Normalize a campaign's raw `target_criteria` JSON into `SmartListCriteria`.
 *
 * Campaigns accumulated two vocabularies over time: the modern plural-key
 * `SmartListCriteria` (written when a campaign is launched from a Smart List or
 * the stage picker), and a legacy flat/singular shape from the original
 * auto-enroller (`status`, `ai_qualification`, `source_type`, `min_score`…).
 * We pass modern keys through untouched and translate the legacy ones, so a
 * single resolver serves every campaign regardless of when it was created.
 */
export function normalizeTargetCriteria(raw: Record<string, unknown>): SmartListCriteria {
  const c = raw || {}
  const out: SmartListCriteria = {}

  // Modern keys pass through verbatim.
  for (const key of SMART_LIST_KEYS) {
    if (c[key] !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(out as any)[key] = c[key]
    }
  }

  // Legacy singular → modern plural (only when the modern form is absent).
  // `status` (original auto-enroller) and `status_in` (blueprint targetCriteria)
  // both map onto `statuses`.
  if (out.statuses === undefined && Array.isArray(c.status)) out.statuses = c.status as string[]
  if (out.statuses === undefined && Array.isArray(c.status_in)) out.statuses = c.status_in as string[]
  if (out.ai_qualifications === undefined && Array.isArray(c.ai_qualification)) out.ai_qualifications = c.ai_qualification as string[]
  if (out.source_types === undefined && Array.isArray(c.source_type)) out.source_types = c.source_type as string[]
  if (out.score_min === undefined && typeof c.min_score === 'number') out.score_min = c.min_score
  if (out.score_max === undefined && typeof c.max_score === 'number') out.score_max = c.max_score

  return out
}

/**
 * Resolve a campaign's audience and create enrollments.
 *
 * Audience precedence:
 *   1. `smart_list_id` — dereferenced live so edits to the list propagate.
 *   2. `target_criteria` — normalized to SmartListCriteria (stages, tags,
 *      keywords, consent, etc.).
 *   3. Neither — enroll nobody (a campaign must declare an audience; this is
 *      the safe default that prevents accidental blasts to the whole DB).
 *
 * Selection runs through the shared `resolveSmartListLeads` engine so campaign
 * targeting is identical to Smart Lists, mass SMS/email, and pipeline recos.
 * Returns the number of NEWLY enrolled leads.
 */
export async function autoEnrollLeads(
  supabase: SupabaseClient,
  campaign: {
    id: string
    organization_id: string
    channel?: 'sms' | 'email' | 'multi' | null
    smart_list_id?: string | null
    allow_unconsented_email?: boolean | null
    target_criteria: Record<string, unknown>
    send_window: Record<string, unknown> | null
  },
  firstStepDelay: number // delay_minutes of step 1
): Promise<number> {
  // Resolve which criteria drive this campaign's audience.
  let criteria: SmartListCriteria | null = null

  if (campaign.smart_list_id) {
    const { data: smartList } = await supabase
      .from('smart_lists')
      .select('criteria')
      .eq('id', campaign.smart_list_id)
      .eq('organization_id', campaign.organization_id)
      .maybeSingle<{ criteria: SmartListCriteria }>()
    if (smartList?.criteria) criteria = smartList.criteria
  }

  if (!criteria) {
    const raw = campaign.target_criteria
    if (raw && Object.keys(raw).length > 0) criteria = normalizeTargetCriteria(raw)
  }

  // No audience configured → enroll nobody (safe default).
  if (!criteria || Object.keys(criteria).length === 0) return 0

  // Shared resolver: handles stages, tags, keywords, states, consent flags, etc.
  const { leadIds } = await resolveSmartListLeads(
    supabase,
    campaign.organization_id,
    criteria,
    { limit: 500 }
  )
  if (leadIds.length === 0) return 0

  // Safety pass over the resolved set: never enroll terminal-state leads, and
  // enforce TCPA/CAN-SPAM consent for single-channel campaigns. (Multi-channel
  // campaigns are gated per-channel by the executor at send time.)
  let safety = supabase
    .from('leads')
    .select('id')
    .eq('organization_id', campaign.organization_id)
    .in('id', leadIds)
    .not('status', 'in', '("disqualified","lost","completed")')

  // Existing patients are the front desk's, not the sales setter's. This is a
  // FLOOR, not a per-campaign opt-in: `is_existing_patient` was already an
  // available criterion, but none of the live campaigns set it, so every
  // "New Leads — …" AI-setter campaign would happily enroll a patient who is
  // mid-treatment. A campaign that genuinely targets patients (the "Existing
  // Patients — Inbound" list) opts back in by asking for them explicitly.
  //
  // Note this is enforced here and not in resolveSmartListLeads: that resolver
  // also backs the Smart List *views*, and silently hiding leads from a list
  // the user is looking at is a different (and worse) behaviour than declining
  // to auto-outreach them.
  if (criteria.is_existing_patient !== true) {
    safety = safety.eq('is_existing_patient', false)
  }

  // Consent is assumed — the only safety exclusion is a per-channel opt-out (DND).
  if (campaign.channel === 'sms') {
    safety = safety.eq('sms_opt_out', false)
  }
  if (campaign.channel === 'email') {
    safety = safety.eq('email_opt_out', false)
  }

  const { data: matchingLeads } = await safety
  if (!matchingLeads || matchingLeads.length === 0) return 0

  // Get already enrolled lead IDs for this campaign
  const { data: existingEnrollments } = await supabase
    .from('campaign_enrollments')
    .select('lead_id')
    .eq('campaign_id', campaign.id)

  const enrolledIds = new Set((existingEnrollments || []).map((e) => e.lead_id))

  // Filter out already enrolled
  const newLeads = matchingLeads.filter((l) => !enrolledIds.has(l.id))
  if (newLeads.length === 0) return 0

  // Calculate first step send time
  const nextStepAt = new Date(Date.now() + firstStepDelay * 60 * 1000).toISOString()

  // Batch insert enrollments
  const enrollments = newLeads.map((l) => ({
    organization_id: campaign.organization_id,
    campaign_id: campaign.id,
    lead_id: l.id,
    status: 'active',
    current_step: 0,
    next_step_at: nextStepAt,
  }))

  // Insert in batches of 100
  let enrolled = 0
  for (let i = 0; i < enrollments.length; i += 100) {
    const batch = enrollments.slice(i, i + 100)
    const { error } = await supabase.from('campaign_enrollments').upsert(batch, {
      onConflict: 'campaign_id,lead_id',
      ignoreDuplicates: true,
    })
    if (!error) enrolled += batch.length
  }

  // Update campaign stats. The cron re-runs daily and only new leads are
  // inserted each pass, so the counter must accumulate — not overwrite with
  // this run's delta (which previously reset total_enrolled to the daily count).
  await supabase
    .from('campaigns')
    .update({ total_enrolled: enrolledIds.size + enrolled })
    .eq('id', campaign.id)

  return enrolled
}
