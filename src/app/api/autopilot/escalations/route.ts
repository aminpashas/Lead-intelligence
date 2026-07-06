import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'

// Strict schema for escalation updates
const escalationPatchSchema = z.object({
  escalation_id: z.string().uuid('Invalid escalation ID format'),
  action: z.enum(['claim', 'resolve', 'dismiss']),
  resolution_notes: z.string().max(2000).optional(),
})

/**
 * GET /api/autopilot/escalations — List pending escalations for the user's org
 * Supports: ?status=pending|claimed|resolved&limit=20
 */

export async function GET(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()

  const { data: profile } = await getOwnProfile(supabase, 'organization_id')

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)

  // Validate status parameter (MED-2: prevent injection)
  const statusParam = url.searchParams.get('status') || 'pending'
  const VALID_STATUSES = ['pending', 'claimed', 'resolved', 'dismissed']
  const status = VALID_STATUSES.includes(statusParam) ? statusParam : 'pending'

  // Safe parseInt with NaN fallback (MED-2 fix)
  const rawLimit = parseInt(url.searchParams.get('limit') || '20', 10)
  const limit = Math.min(Number.isNaN(rawLimit) ? 20 : rawLimit, 50)

  const { data: escalations, error } = await supabase
    .from('escalations')
    .select(`
      id,
      reason,
      ai_notes,
      ai_draft_response,
      ai_confidence,
      agent_type,
      priority,
      status,
      claimed_by,
      created_at,
      lead_id,
      conversation_id,
      leads:lead_id (first_name, last_name, status, ai_score)
    `)
    .eq('organization_id', orgId)
    .eq('status', status)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Surface urgent/high (clinical) escalations first, newest-first within a
  // priority band. Ranked in JS because the column is text, not numeric — an
  // alphabetical DB sort would misorder ('high' < 'low' < 'normal' < 'urgent').
  const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 }
  const sorted = (escalations || []).slice().sort((a, b) => {
    const ra = PRIORITY_RANK[(a.priority as string) ?? 'normal'] ?? 2
    const rb = PRIORITY_RANK[(b.priority as string) ?? 'normal'] ?? 2
    return ra - rb // created_at desc is already the stable base order
  })

  // Get count of pending escalations
  const { count } = await supabase
    .from('escalations')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId)
    .eq('status', 'pending')

  return NextResponse.json({
    escalations: sorted,
    pending_count: count || 0,
  })
}

/**
 * PATCH /api/autopilot/escalations — Claim or resolve an escalation
 * Body: { escalation_id, action: 'claim' | 'resolve' | 'dismiss', resolution_notes? }
 */
export async function PATCH(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()

  const { data: profile } = await getOwnProfile(supabase, 'id, organization_id')

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Safe JSON parsing (MED-5 fix)
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // Zod validation (CRIT-3 fix)
  const parsed = escalationPatchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { escalation_id, action, resolution_notes } = parsed.data

  // Verify escalation belongs to user's org
  const { data: escalation } = await supabase
    .from('escalations')
    .select('id, status')
    .eq('id', escalation_id)
    .eq('organization_id', orgId)
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
  }

  await supabase
    .from('escalations')
    .update(updates)
    .eq('id', escalation_id)

  return NextResponse.json({ ok: true, action, escalation_id })
}
