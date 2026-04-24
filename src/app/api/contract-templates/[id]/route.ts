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

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const c = await ctx()
  if ('error' in c) return c.error
  const { id } = await params
  const { data, error } = await c.supabase
    .from('contract_templates')
    .select('*')
    .eq('id', id)
    .eq('organization_id', c.profile.organization_id)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ template: data })
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const c = await ctx()
  if ('error' in c) return c.error
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const updates: Record<string, unknown> = {}
  if (typeof body.name === 'string') updates.name = body.name
  if (Array.isArray(body.sections)) updates.sections = body.sections
  if (Array.isArray(body.required_variables)) updates.required_variables = body.required_variables

  const { data: existing } = await c.supabase
    .from('contract_templates')
    .select('status')
    .eq('id', id)
    .eq('organization_id', c.profile.organization_id)
    .maybeSingle()
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (existing.status === 'published') {
    return NextResponse.json(
      { error: 'Published templates are immutable. Create a new draft instead.' },
      { status: 409 }
    )
  }

  const { data, error } = await c.supabase
    .from('contract_templates')
    .update(updates)
    .eq('id', id)
    .select()
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ template: data })
}
