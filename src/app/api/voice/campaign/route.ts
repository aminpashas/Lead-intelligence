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

  const { data: campaigns } = await authClient
    .from('voice_campaigns')
    .select('*')
    .eq('organization_id', profile.organization_id)
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
  if (!['owner', 'admin', 'manager'].includes(profile.role)) {
    return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 })
  }

  const body = await request.json()
  const {
    name,
    description,
    smart_list_id,
    agent_type,
    active_hours_start,
    active_hours_end,
    active_days,
    timezone,
    max_attempts_per_lead,
    calls_per_hour,
    concurrent_calls,
    custom_greeting,
    custom_voicemail,
  } = body

  if (!name) {
    return NextResponse.json({ error: 'Campaign name is required' }, { status: 400 })
  }

  const supabase = createServiceClient()

  const { data: campaign, error } = await supabase
    .from('voice_campaigns')
    .insert({
      organization_id: profile.organization_id,
      created_by: user.id,
      name,
      description: description || null,
      smart_list_id: smart_list_id || null,
      agent_type: agent_type || 'setter',
      active_hours_start: active_hours_start ?? 9,
      active_hours_end: active_hours_end ?? 18,
      active_days: active_days || ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      timezone: timezone || 'America/New_York',
      max_attempts_per_lead: max_attempts_per_lead ?? 3,
      calls_per_hour: calls_per_hour ?? 20,
      concurrent_calls: concurrent_calls ?? 1,
      custom_greeting: custom_greeting || null,
      custom_voicemail: custom_voicemail || null,
      status: 'draft',
    })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Auto-populate the queue if a smart list was provided
  if (smart_list_id && campaign) {
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
  if (!['owner', 'admin', 'manager'].includes(profile.role)) {
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
    .select('id, status, organization_id')
    .eq('id', campaign_id)
    .eq('organization_id', profile.organization_id)
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

    // Immediately process the first batch
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
    'active_days', 'timezone', 'max_attempts_per_lead', 'calls_per_hour',
    'concurrent_calls', 'custom_greeting', 'custom_voicemail', 'agent_type',
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
