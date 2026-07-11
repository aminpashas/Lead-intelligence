import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { hasPermission } from '@/lib/auth/permissions'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { getBrandingForOrg, upsertBranding } from '@/lib/branding/store'
import { brandingPatchSchema } from '@/lib/branding/schema'

export const runtime = 'nodejs'

async function ctx(_request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .single()
  if (!profile || !hasPermission(profile.role, 'branding:manage')) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  // Effective org honors an agency_admin's entered client account.
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  return { supabase, orgId }
}

export async function GET(request: NextRequest) {
  const c = await ctx(request)
  if ('error' in c) return c.error
  const { branding, orgName } = await getBrandingForOrg(c.supabase, c.orgId)
  return NextResponse.json({ branding, orgName })
}

export async function PATCH(request: NextRequest) {
  const c = await ctx(request)
  if ('error' in c) return c.error
  const body = await request.json().catch(() => ({}))
  const parsed = brandingPatchSchema.safeParse(body?.branding ?? {})
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, { status: 400 })
  }
  const result = await upsertBranding(c.supabase, c.orgId, parsed.data)
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 500 })
  return NextResponse.json({ ok: true, branding: result.branding })
}
