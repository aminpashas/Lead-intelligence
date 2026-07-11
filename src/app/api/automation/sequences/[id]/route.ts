import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { hasPermission } from '@/lib/auth/permissions'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'

/**
 * PATCH  /api/automation/sequences/[id] — sequence-level flags (enable/pause,
 *        name, stop conditions).
 * DELETE /api/automation/sequences/[id] — custom (non-system) sequences only.
 */

const patchSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  description: z.string().max(500).nullable().optional(),
  enabled: z.boolean().optional(),
  stop_on_reply: z.boolean().optional(),
  stop_on_booking: z.boolean().optional(),
})

async function authorize(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return { error: rlError }

  const supabase = await createClient()
  const { data: profile } = await getOwnProfile(supabase, 'organization_id, role')
  if (!profile) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  if (!hasPermission(profile.role, 'ai_control:write')) {
    return { error: NextResponse.json({ error: 'Workflows are managed by your agency' }, { status: 403 }) }
  }
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  return { supabase, orgId }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await authorize(request)
  if ('error' in auth) return auth.error
  const { supabase, orgId } = auth

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = patchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid update', details: parsed.error.flatten() }, { status: 400 })
  }
  const updates = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined))
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
  }

  const { data: updated, error } = await supabase
    .from('outreach_sequences')
    .update(updates)
    .eq('id', id)
    .eq('organization_id', orgId)
    .select('*')
    .single()

  if (error || !updated) {
    return NextResponse.json({ error: 'Sequence not found or update failed', detail: error?.message }, { status: 404 })
  }
  return NextResponse.json({ sequence: updated })
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await authorize(request)
  if ('error' in auth) return auth.error
  const { supabase, orgId } = auth

  const { data: seq } = await supabase
    .from('outreach_sequences')
    .select('id, is_system')
    .eq('id', id)
    .eq('organization_id', orgId)
    .maybeSingle()
  if (!seq) return NextResponse.json({ error: 'Sequence not found' }, { status: 404 })
  if (seq.is_system) {
    return NextResponse.json({ error: 'Built-in sequences cannot be deleted — disable them instead' }, { status: 400 })
  }

  const { error } = await supabase
    .from('outreach_sequences')
    .delete()
    .eq('id', id)
    .eq('organization_id', orgId)
  if (error) return NextResponse.json({ error: 'Delete failed', detail: error.message }, { status: 500 })
  return NextResponse.json({ deleted: true })
}
