import type { SupabaseClient } from '@supabase/supabase-js'

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
    .select('campaign_id, step_number, exit_condition')
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

/**
 * Match leads against a campaign's target_criteria and create enrollments.
 * Returns the number of newly enrolled leads.
 */
export async function autoEnrollLeads(
  supabase: SupabaseClient,
  campaign: {
    id: string
    organization_id: string
    target_criteria: Record<string, unknown>
    send_window: Record<string, unknown> | null
  },
  firstStepDelay: number // delay_minutes of step 1
): Promise<number> {
  const criteria = campaign.target_criteria
  if (!criteria || Object.keys(criteria).length === 0) return 0

  // Build lead query from target_criteria
  let query = supabase
    .from('leads')
    .select('id')
    .eq('organization_id', campaign.organization_id)

  // Filter by status
  if (criteria.status && Array.isArray(criteria.status)) {
    query = query.in('status', criteria.status)
  }

  // Filter by AI qualification
  if (criteria.ai_qualification && Array.isArray(criteria.ai_qualification)) {
    query = query.in('ai_qualification', criteria.ai_qualification)
  }

  // Filter by source type
  if (criteria.source_type && Array.isArray(criteria.source_type)) {
    query = query.in('source_type', criteria.source_type)
  }

  // Filter by score range
  if (typeof criteria.min_score === 'number') {
    query = query.gte('ai_score', criteria.min_score)
  }
  if (typeof criteria.max_score === 'number') {
    query = query.lte('ai_score', criteria.max_score)
  }

  // Filter by has phone (for SMS campaigns)
  if (criteria.has_phone === true) {
    query = query.not('phone_formatted', 'is', null)
  }

  // Filter by has email (for email campaigns)
  if (criteria.has_email === true) {
    query = query.not('email', 'is', null)
  }

  // Filter by created_after (only leads created after a certain date)
  if (criteria.created_after) {
    query = query.gte('created_at', criteria.created_after as string)
  }

  // Exclude already disqualified/lost
  query = query.not('status', 'in', '("disqualified","lost","completed")')

  // TCPA/CAN-SPAM: Only enroll leads with proper consent
  if (criteria.has_phone === true) {
    // SMS campaigns require explicit SMS consent and no opt-out
    query = query.eq('sms_consent', true).eq('sms_opt_out', false)
  }
  if (criteria.has_email === true) {
    // Email campaigns require email consent and no opt-out
    query = query.eq('email_consent', true).eq('email_opt_out', false)
  }

  const { data: matchingLeads } = await query.limit(500)
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

  // Update campaign stats
  await supabase
    .from('campaigns')
    .update({ total_enrolled: enrolled })
    .eq('id', campaign.id)

  return enrolled
}
