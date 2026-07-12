/**
 * Agency "active account" selection.
 *
 *   POST   { org_id }  → agency admin enters a client account
 *   DELETE             → agency admin exits back to the agency console
 *
 * Only agency_admin may use these. The selected org must be one the agency
 * admin can see (RLS on `organizations` already grants agency admins SELECT on
 * all orgs — migration 018), which prevents entering an arbitrary org id.
 *
 * Once a row exists in `agency_active_org`, `get_user_org_id()` (migration 038)
 * resolves the whole app to the selected client.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { requireAgencyCapability } from '@/lib/auth/active-org'

export async function POST(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Only owners + managers may enter/exit a client account (analysts are
  // read-only at the agency level and do not operate inside accounts).
  const guard = await requireAgencyCapability(supabase, 'agency:enter_account')
  if ('error' in guard) return guard.error

  const body = (await request.json().catch(() => ({}))) as { org_id?: string }
  if (!body.org_id) {
    return NextResponse.json({ error: 'org_id is required' }, { status: 400 })
  }

  // Confirm the org is visible to this agency admin. RLS scopes the SELECT to
  // orgs the agency admin is allowed to see, so a not-found result means the
  // requested org is out of bounds.
  const { data: org } = await supabase
    .from('organizations')
    .select('id, name')
    .eq('id', body.org_id)
    .single()

  if (!org) {
    return NextResponse.json({ error: 'Account not found' }, { status: 404 })
  }

  const { error } = await supabase
    .from('agency_active_org')
    .upsert(
      { user_id: user.id, active_org_id: org.id, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    )

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, organization: { id: org.id, name: org.name } })
}

export async function DELETE(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // RLS already restricts deletes to the caller's own row; scope by user_id too
  // for clarity and so a non-agency caller is simply a no-op.
  const { error } = await supabase
    .from('agency_active_org')
    .delete()
    .eq('user_id', user.id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
