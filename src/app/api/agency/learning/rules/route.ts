/**
 * GET   /api/agency/learning/rules — list auto-learned rules (pending first)
 * PATCH /api/agency/learning/rules — approve / reject / retire a candidate
 *
 * Agency-admin only (RLS on agency_ai_rules enforces the same, but we return a
 * clean 403). This is the human gate of the learning loop: candidates written
 * by the weekly distillation cron are invisible to live agents until an
 * approval here flips is_enabled — approval is the ONLY path to live.
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
    .single()
  if (!profile || profile.role !== 'agency_admin') {
    return { error: NextResponse.json({ error: 'Forbidden — agency access required' }, { status: 403 }) }
  }
  return { supabase, user }
}

export async function GET(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const auth = await requireAgencyAdmin()
  if ('error' in auth) return auth.error

  const [{ data: rules }, { data: runs }] = await Promise.all([
    auth.supabase
      .from('agency_ai_rules')
      .select('*')
      .eq('source', 'auto_learning')
      .order('created_at', { ascending: false })
      .limit(100),
    auth.supabase
      .from('learning_runs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(5),
  ])

  return NextResponse.json({ rules: rules || [], runs: runs || [] })
}

const patchSchema = z.object({
  id: z.string().uuid(),
  action: z.enum(['approve', 'reject', 'retire']),
})

export async function PATCH(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const auth = await requireAgencyAdmin()
  if ('error' in auth) return auth.error

  const parsed = patchSchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  const nowIso = new Date().toISOString()
  const actor = auth.user.email || auth.user.id
  const { id, action } = parsed.data

  const update =
    action === 'approve'
      ? {
          is_enabled: true,
          review_status: 'approved',
          approved_by: actor,
          approved_at: nowIso,
          enabled_at: nowIso,
          retired_at: null,
          retirement_reason: null,
        }
      : action === 'reject'
        ? {
            is_enabled: false,
            review_status: 'rejected',
            retired_at: nowIso,
            retirement_reason: `rejected_by:${actor}`,
          }
        : {
            is_enabled: false,
            review_status: 'retired',
            retired_at: nowIso,
            retirement_reason: `retired_by:${actor}`,
          }

  const { data, error } = await auth.supabase
    .from('agency_ai_rules')
    .update(update)
    .eq('id', id)
    .eq('source', 'auto_learning') // this endpoint never touches hand-authored rules
    .select('id, review_status, is_enabled')
    .single()

  if (error || !data) {
    return NextResponse.json({ error: error?.message || 'Rule not found' }, { status: 404 })
  }

  return NextResponse.json({ rule: data })
}
