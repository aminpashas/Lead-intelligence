/**
 * Voice Campaign Management API
 *
 * POST   /api/voice/campaign — Create a new voice campaign
 * GET    /api/voice/campaign — List campaigns
 * PATCH  /api/voice/campaign — Update campaign (start, pause, etc.)
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { createClient } from '@/lib/supabase/server'
import { populateCampaignQueue, processVoiceCampaign } from '@/lib/voice/campaign-dialer'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { hasPermission } from '@/lib/auth/permissions'
import { logger } from '@/lib/logger'

// ── GET: List voice campaigns ────────────────────────────────
export async function GET() {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await authClient
    .from('user_profiles')
    .select('organization_id')
    .eq('id', user.id)
    .single()

  if (!profile) return NextResponse.json({ error: 'No org' }, { status: 403 })
  // Effective org honors an agency_admin's entered client account.
  const { orgId } = await resolveActiveOrg(authClient)
  if (!orgId) return NextResponse.json({ error: 'No org' }, { status: 403 })

  const { data: campaigns } = await authClient
    .from('voice_campaigns')
    .select('*')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })

  return NextResponse.json({ campaigns: campaigns || [] })
}

// ── POST: Create a voice campaign ────────────────────────────
export async function POST(request: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await authClient
    .from('user_profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .single()

  if (!profile) return NextResponse.json({ error: 'No org' }, { status: 403 })
  // Effective org honors an agency_admin's entered client account.
  const { orgId } = await resolveActiveOrg(authClient)
  if (!orgId) return NextResponse.json({ error: 'No org' }, { status: 403 })
  // Automatic outbound calling stays a practice capability (per onboarding
  // scope), but is limited to roles with call-center write — practice admins,
  // office managers, and treatment coordinators — not clinical-only staff.
  // Also replaces the stale legacy-only role list so the healthcare roles work.
  if (!hasPermission(profile.role, 'call_center:write')) {
    return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 })
  }

  const body = await request.json()
  const {
    name,
    description,
    smart_list_id,
    stage_id,
    auto_enroll,
    agent_type,
    active_hours_start,
    active_hours_end,
    active_days,
    timezone,
    max_attempts_per_lead,
    retry_delay_hours,
    calls_per_hour,
    concurrent_calls,
    custom_greeting,
    custom_voicemail,
    live_transfer_enabled,
    transfer_mode,
    dial_ratio,
    max_hold_seconds,
  } = body

  if (!name) {
    return NextResponse.json({ error: 'Campaign name is required' }, { status: 400 })
  }

  // A calling automation forwards answered calls to a person. When that's on,
  // require a valid handoff style so the dispatcher never dials with an unknown
  // transfer_mode. Default to the safest single-agent setting.
  const VALID_TRANSFER_MODES = ['immediate', 'greet_transfer', 'qualify_transfer']
  const resolvedTransferMode =
    transfer_mode && VALID_TRANSFER_MODES.includes(transfer_mode) ? transfer_mode : 'immediate'

  // Audience: a pipeline stage (builder default) is carried in target_criteria so
  // populateCampaignQueue and the auto-enroll sweep can both read it. auto_enroll
  // marks a standing automation (keep dialing new leads that land in the stage).
  const target_criteria: Record<string, unknown> = {}
  if (typeof stage_id === 'string' && stage_id) target_criteria.stage_id = stage_id
  if (auto_enroll) target_criteria.auto_enroll = true

  const supabase = createServiceClient()

  const { data: campaign, error } = await supabase
    .from('voice_campaigns')
    .insert({
      organization_id: orgId,
      created_by: user.id,
      name,
      description: description || null,
      smart_list_id: smart_list_id || null,
      target_criteria,
      agent_type: agent_type || 'setter',
      active_hours_start: active_hours_start ?? 9,
      active_hours_end: active_hours_end ?? 18,
      active_days: active_days || ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      timezone: timezone || 'America/New_York',
      max_attempts_per_lead: max_attempts_per_lead ?? 3,
      retry_delay_hours: retry_delay_hours ?? 48,
      calls_per_hour: calls_per_hour ?? 20,
      concurrent_calls: concurrent_calls ?? 1,
      custom_greeting: custom_greeting || null,
      custom_voicemail: custom_voicemail || null,
      live_transfer_enabled: !!live_transfer_enabled,
      transfer_mode: resolvedTransferMode,
      dial_ratio: dial_ratio ?? 1.0,
      max_hold_seconds: max_hold_seconds ?? null,
      status: 'draft',
    })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Auto-populate the queue from whichever audience was set (stage or smart list).
  if (campaign && (target_criteria.stage_id || smart_list_id)) {
    const queueResult = await populateCampaignQueue(supabase, campaign.id)
    logger.info('Voice campaign created with queue', {
      campaign_id: campaign.id,
      leads_queued: queueResult.leads_added,
    })
  }

  return NextResponse.json({ campaign })
}

// ── PATCH: Update campaign (start, pause, etc.) ──────────────
export async function PATCH(request: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await authClient
    .from('user_profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .single()

  if (!profile) return NextResponse.json({ error: 'No org' }, { status: 403 })
  // Effective org honors an agency_admin's entered client account.
  const { orgId } = await resolveActiveOrg(authClient)
  if (!orgId) return NextResponse.json({ error: 'No org' }, { status: 403 })
  // Automatic outbound calling stays a practice capability (per onboarding
  // scope), but is limited to roles with call-center write — practice admins,
  // office managers, and treatment coordinators — not clinical-only staff.
  // Also replaces the stale legacy-only role list so the healthcare roles work.
  if (!hasPermission(profile.role, 'call_center:write')) {
    return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 })
  }

  const body = await request.json()
  const { campaign_id, action, ...updates } = body

  if (!campaign_id) {
    return NextResponse.json({ error: 'campaign_id is required' }, { status: 400 })
  }

  const supabase = createServiceClient()

  // Verify campaign belongs to this org
  const { data: campaign } = await supabase
    .from('voice_campaigns')
    .select('id, status, organization_id, live_transfer_enabled')
    .eq('id', campaign_id)
    .eq('organization_id', orgId)
    .single()

  if (!campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
  }

  // Handle action-based operations
  if (action === 'start') {
    if (campaign.status !== 'draft' && campaign.status !== 'paused') {
      return NextResponse.json({ error: `Cannot start campaign in status: ${campaign.status}` }, { status: 422 })
    }

    await supabase
      .from('voice_campaigns')
      .update({ status: 'active', scheduled_start_at: new Date().toISOString() })
      .eq('id', campaign_id)

    // Live-transfer campaigns are paced by the dispatcher cron (which dials WITH
    // the transfer flag). Running processVoiceCampaign here would place the first
    // batch as plain AI calls with no human handoff — so only kick it for
    // non-transfer campaigns. Live ones just go 'active' and the cron takes over.
    if (campaign.live_transfer_enabled) {
      return NextResponse.json({ status: 'active', dialer: 'live_transfer_dispatcher' })
    }

    const dialResult = await processVoiceCampaign(supabase, campaign_id)
    return NextResponse.json({ status: 'active', dial_result: dialResult })
  }

  if (action === 'pause') {
    await supabase
      .from('voice_campaigns')
      .update({ status: 'paused' })
      .eq('id', campaign_id)

    return NextResponse.json({ status: 'paused' })
  }

  if (action === 'populate_queue') {
    const queueResult = await populateCampaignQueue(supabase, campaign_id)
    return NextResponse.json({ leads_added: queueResult.leads_added })
  }

  // General field updates
  const allowedFields = [
    'name', 'description', 'active_hours_start', 'active_hours_end',
    'active_days', 'timezone', 'max_attempts_per_lead', 'retry_delay_hours',
    'calls_per_hour', 'concurrent_calls', 'custom_greeting', 'custom_voicemail',
    'agent_type', 'live_transfer_enabled', 'transfer_mode', 'dial_ratio',
    'max_hold_seconds', 'target_criteria',
  ]

  const sanitizedUpdates: Record<string, unknown> = {}
  for (const key of allowedFields) {
    if (key in updates) {
      sanitizedUpdates[key] = updates[key]
    }
  }

  if (Object.keys(sanitizedUpdates).length > 0) {
    await supabase
      .from('voice_campaigns')
      .update(sanitizedUpdates)
      .eq('id', campaign_id)
  }

  return NextResponse.json({ updated: true })
}
