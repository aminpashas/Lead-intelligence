import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * GET /api/autopilot/escalations — List pending escalations for the user's org
 * Supports: ?status=pending|claimed|resolved&limit=20
 */

export async function GET(request: NextRequest) {
  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const status = url.searchParams.get('status') || 'pending'
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50)

  const { data: escalations, error } = await supabase
    .from('escalations')
    .select(`
      id,
      reason,
      ai_notes,
      ai_draft_response,
      ai_confidence,
      agent_type,
      status,
      claimed_by,
      created_at,
      lead_id,
      conversation_id,
      leads:lead_id (first_name, last_name, status, ai_score)
    `)
    .eq('organization_id', profile.organization_id)
    .eq('status', status)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Get count of pending escalations
  const { count } = await supabase
    .from('escalations')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', profile.organization_id)
    .eq('status', 'pending')

  return NextResponse.json({
    escalations: escalations || [],
    pending_count: count || 0,
  })
}

/**
 * PATCH /api/autopilot/escalations — Claim or resolve an escalation
 * Body: { escalation_id, action: 'claim' | 'resolve' | 'dismiss', resolution_notes? }
 */
export async function PATCH(request: NextRequest) {
  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const { escalation_id, action, resolution_notes } = body

  if (!escalation_id || !action) {
    return NextResponse.json({ error: 'escalation_id and action required' }, { status: 400 })
  }

  // Verify escalation belongs to user's org
  const { data: escalation } = await supabase
    .from('escalations')
    .select('id, status')
    .eq('id', escalation_id)
    .eq('organization_id', profile.organization_id)
    .single()

  if (!escalation) {
    return NextResponse.json({ error: 'Escalation not found' }, { status: 404 })
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }

  switch (action) {
    case 'claim':
      updates.status = 'claimed'
      updates.claimed_by = profile.id
      updates.claimed_at = new Date().toISOString()
      break
    case 'resolve':
      updates.status = 'resolved'
      updates.resolved_at = new Date().toISOString()
      updates.resolution_notes = resolution_notes || null
      break
    case 'dismiss':
      updates.status = 'dismissed'
      updates.resolved_at = new Date().toISOString()
      updates.resolution_notes = resolution_notes || 'Dismissed by staff'
      break
    default:
      return NextResponse.json({ error: 'Invalid action. Use: claim, resolve, dismiss' }, { status: 400 })
  }

  await supabase
    .from('escalations')
    .update(updates)
    .eq('id', escalation_id)

  return NextResponse.json({ ok: true, action, escalation_id })
}
