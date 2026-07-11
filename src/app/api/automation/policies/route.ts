import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { hasPermission } from '@/lib/auth/permissions'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { automationPolicyInput } from '@/lib/validators/automation-policy'

/**
 * GET /api/automation/policies — list this org's automation policies (any authenticated member).
 * POST /api/automation/policies — create a policy (ai_control:write only).
 * PATCH /api/automation/policies — update a policy by id (ai_control:write only).
 * DELETE /api/automation/policies?id=... — delete a policy (ai_control:write only).
 */

export async function GET(request: NextRequest) {
  const rl = applyRateLimit(request, RATE_LIMITS.api)
  if (rl) return rl

  const supabase = await createClient()
  const { data: profile } = await getOwnProfile(supabase, 'organization_id')
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabase
    .from('automation_policies')
    .select('*')
    .eq('organization_id', orgId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ policies: data ?? [] })
}

async function requireWriter(supabase: Awaited<ReturnType<typeof createClient>>) {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!profile || !hasPermission(profile.role, 'ai_control:write')) {
    return { error: NextResponse.json({ error: 'AI settings are managed by your agency' }, { status: 403 }) }
  }

  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  return { orgId }
}

export async function POST(request: NextRequest) {
  const rl = applyRateLimit(request, RATE_LIMITS.api)
  if (rl) return rl

  const supabase = await createClient()
  const gate = await requireWriter(supabase)
  if ('error' in gate) return gate.error

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = automationPolicyInput.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid policy', details: parsed.error.flatten() }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('automation_policies')
    .insert({ ...parsed.data, organization_id: gate.orgId })
    .select('*')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ policy: data }, { status: 201 })
}

export async function PATCH(request: NextRequest) {
  const rl = applyRateLimit(request, RATE_LIMITS.api)
  if (rl) return rl

  const supabase = await createClient()
  const gate = await requireWriter(supabase)
  if ('error' in gate) return gate.error

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { id, ...rest } = (body ?? {}) as { id?: string }
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const parsed = automationPolicyInput.partial().safeParse(rest)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid policy', details: parsed.error.flatten() }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('automation_policies')
    .update(parsed.data)
    .eq('id', id)
    .eq('organization_id', gate.orgId)
    .select('*')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ policy: data })
}

export async function DELETE(request: NextRequest) {
  const rl = applyRateLimit(request, RATE_LIMITS.api)
  if (rl) return rl

  const supabase = await createClient()
  const gate = await requireWriter(supabase)
  if ('error' in gate) return gate.error

  const id = new URL(request.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const { error } = await supabase
    .from('automation_policies')
    .delete()
    .eq('id', id)
    .eq('organization_id', gate.orgId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
