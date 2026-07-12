/**
 * /api/agency/enterprises/[id]
 *
 * Agency-admin operations on a single enterprise account:
 *   PATCH { name }                  → rename the enterprise
 *   PATCH { assign_org, unassign }  → attach / detach a location (organization)
 *                                     to/from this enterprise
 *
 * Reassignment writes organizations.enterprise_account_id. Detach sets it NULL
 * (the location becomes standalone). Agency-admin only, like the collection route.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { requireAgencyCapability } from '@/lib/auth/active-org'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const { id } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const cap = await requireAgencyCapability(supabase, 'agency:enterprises_manage')
  if ('error' in cap) return cap.error

  const body = (await request.json().catch(() => ({}))) as {
    name?: string
    assign_org?: string
    unassign?: boolean
  }

  // Reassign a location to / away from this enterprise.
  if (body.assign_org) {
    const { error } = await supabase
      .from('organizations')
      .update({ enterprise_account_id: body.unassign ? null : id })
      .eq('id', body.assign_org)
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  }

  // Rename the enterprise.
  const name = body.name?.trim()
  if (!name) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }
  const { data: enterprise, error } = await supabase
    .from('enterprise_accounts')
    .update({ name })
    .eq('id', id)
    .select('id, name, slug, created_at, updated_at')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ enterprise })
}
