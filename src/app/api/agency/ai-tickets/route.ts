/**
 * PATCH /api/agency/ai-tickets — triage an AI improvement ticket
 * (acknowledge / start / resolve / dismiss / reopen).
 *
 * Agency-admin only (RLS on ai_improvement_tickets enforces the same; we
 * return a clean 403). Tickets are WRITTEN by the post-call review pipeline
 * (service role) — this endpoint only moves them through the triage states.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { z } from 'zod'

async function requireAgencyAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()
  if (!profile || profile.role !== 'agency_admin') {
    return { error: NextResponse.json({ error: 'Forbidden — agency access required' }, { status: 403 }) }
  }
  return { supabase, user }
}

const patchSchema = z.object({
  id: z.string().uuid(),
  action: z.enum(['acknowledge', 'start', 'resolve', 'dismiss', 'reopen']),
  resolution_note: z.string().max(2000).optional(),
})

const ACTION_STATUS: Record<z.infer<typeof patchSchema>['action'], string> = {
  acknowledge: 'acknowledged',
  start: 'in_progress',
  resolve: 'resolved',
  dismiss: 'dismissed',
  reopen: 'open',
}

export async function PATCH(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const auth = await requireAgencyAdmin()
  if ('error' in auth) return auth.error

  const parsed = patchSchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  const { id, action, resolution_note } = parsed.data
  const nowIso = new Date().toISOString()
  const terminal = action === 'resolve' || action === 'dismiss'

  const { data, error } = await auth.supabase
    .from('ai_improvement_tickets')
    .update({
      status: ACTION_STATUS[action],
      updated_at: nowIso,
      ...(terminal
        ? {
            resolution_note: resolution_note ?? null,
            resolved_by: auth.user.id,
            resolved_at: nowIso,
          }
        : action === 'reopen'
          ? { resolution_note: null, resolved_by: null, resolved_at: null }
          : {}),
    })
    .eq('id', id)
    .select('id, status')
    .single()

  if (error || !data) {
    return NextResponse.json({ error: error?.message || 'Ticket not found' }, { status: 404 })
  }

  return NextResponse.json({ ticket: data })
}
