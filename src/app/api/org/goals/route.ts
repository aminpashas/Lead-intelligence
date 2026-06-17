/**
 * /api/org/goals — org-level goal CRUD (Phase 5.1), gated by the `org_goals` flag.
 *   GET  → list goals for the caller's org
 *   POST → create a goal { metric, target_value, period_start, period_end, label? }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getOrgFlags, flagOn } from '@/lib/org/flags'

const METRICS = ['pipeline_value', 'conversions', 'revenue', 'bookings', 'qualification_rate']

async function resolveOrg() {
  const authed = await createClient()
  const { data: { user } } = await authed.auth.getUser()
  if (!user) return { error: 'Unauthorized' as const, status: 401 }
  const { data: profile } = await authed
    .from('user_profiles')
    .select('organization_id')
    .eq('id', user.id)
    .single()
  if (!profile?.organization_id) return { error: 'No organization' as const, status: 403 }
  return { authed, user, organizationId: profile.organization_id as string }
}

export async function GET() {
  const ctx = await resolveOrg()
  if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

  const { data, error } = await ctx.authed
    .from('org_goals')
    .select('*')
    .eq('organization_id', ctx.organizationId)
    .order('period_end', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ goals: data ?? [] })
}

export async function POST(request: NextRequest) {
  const ctx = await resolveOrg()
  if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

  const flags = await getOrgFlags(createServiceClient(), ctx.organizationId)
  if (!flagOn(flags, 'org_goals')) {
    return NextResponse.json({ error: 'org_goals_disabled' }, { status: 409 })
  }

  const body = (await request.json().catch(() => null)) as {
    metric?: string
    target_value?: number
    period_start?: string
    period_end?: string
    label?: string
  } | null

  if (!body?.metric || !METRICS.includes(body.metric)) {
    return NextResponse.json({ error: `metric must be one of ${METRICS.join(', ')}` }, { status: 400 })
  }
  if (typeof body.target_value !== 'number' || !(body.target_value > 0)) {
    return NextResponse.json({ error: 'target_value must be a positive number' }, { status: 400 })
  }
  if (!body.period_start || !body.period_end) {
    return NextResponse.json({ error: 'period_start and period_end are required' }, { status: 400 })
  }
  if (new Date(body.period_end).getTime() <= new Date(body.period_start).getTime()) {
    return NextResponse.json({ error: 'period_end must be after period_start' }, { status: 400 })
  }

  const { data, error } = await ctx.authed
    .from('org_goals')
    .insert({
      organization_id: ctx.organizationId,
      metric: body.metric,
      target_value: body.target_value,
      period_start: body.period_start,
      period_end: body.period_end,
      label: body.label ?? null,
      created_by: ctx.user.id,
    })
    .select('id')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, id: data.id }, { status: 201 })
}
