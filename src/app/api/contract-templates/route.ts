import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { hasPermission } from '@/lib/auth/permissions'

export const runtime = 'nodejs'

async function ctx() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .single()
  if (!profile || !hasPermission(profile.role, 'contract_templates:manage')) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  return { supabase, profile, user }
}

export async function GET() {
  const c = await ctx()
  if ('error' in c) return c.error
  const { data, error } = await c.supabase
    .from('contract_templates')
    .select('id, name, slug, version, status, sections, required_variables, published_at, updated_at')
    .eq('organization_id', c.profile.organization_id)
    .order('slug')
    .order('version', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ templates: data ?? [] })
}

export async function POST(request: NextRequest) {
  const c = await ctx()
  if ('error' in c) return c.error
  const body = await request.json().catch(() => ({}))
  const { slug, name, sections, required_variables } = body
  if (!slug || !name || !Array.isArray(sections)) {
    return NextResponse.json({ error: 'slug, name, sections[] are required' }, { status: 400 })
  }
  // Bump version if one already exists for this slug
  const { data: existing } = await c.supabase
    .from('contract_templates')
    .select('version')
    .eq('organization_id', c.profile.organization_id)
    .eq('slug', slug)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  const nextVersion = (existing?.version ?? 0) + 1

  const { data, error } = await c.supabase
    .from('contract_templates')
    .insert({
      organization_id: c.profile.organization_id,
      slug,
      name,
      version: nextVersion,
      sections,
      required_variables: required_variables ?? [],
      status: 'draft',
      created_by: c.user.id,
    })
    .select()
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ template: data })
}
