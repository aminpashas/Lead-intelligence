import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { hasPermission } from '@/lib/auth/permissions'

export const runtime = 'nodejs'

async function ctx(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .single()
  if (!profile || !hasPermission(profile.role, 'legal_settings:manage')) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  return { supabase, profile, user }
}

export async function GET(request: NextRequest) {
  const c = await ctx(request)
  if ('error' in c) return c.error
  const { data } = await c.supabase
    .from('organizations')
    .select('settings')
    .eq('id', c.profile.organization_id)
    .single()
  const settings = (data?.settings ?? {}) as { legal?: unknown; contracts?: unknown }
  return NextResponse.json({
    legal: settings.legal ?? {},
    contracts: settings.contracts ?? {},
  })
}

export async function PATCH(request: NextRequest) {
  const c = await ctx(request)
  if ('error' in c) return c.error

  const body = await request.json().catch(() => ({}))
  const legal = (body.legal ?? {}) as Record<string, unknown>
  const contracts = (body.contracts ?? {}) as Record<string, unknown>

  // Load current settings and merge
  const { data: current } = await c.supabase
    .from('organizations')
    .select('settings')
    .eq('id', c.profile.organization_id)
    .single()
  const currentSettings = (current?.settings ?? {}) as Record<string, unknown>
  const currentLegal = (currentSettings.legal ?? {}) as Record<string, unknown>
  const currentContracts = (currentSettings.contracts ?? {}) as Record<string, unknown>

  const merged = {
    ...currentSettings,
    legal: { ...currentLegal, ...legal },
    contracts: { ...currentContracts, ...contracts },
  }

  const { error } = await c.supabase
    .from('organizations')
    .update({ settings: merged })
    .eq('id', c.profile.organization_id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, legal: merged.legal, contracts: merged.contracts })
}
