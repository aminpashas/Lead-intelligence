import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { hasPermission } from '@/lib/auth/permissions'

export const runtime = 'nodejs'

/**
 * POST /api/contract-templates/[id]/publish
 * Archives any currently-published template with the same slug and publishes this one.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .single()
  if (!profile || !hasPermission(profile.role, 'contract_templates:manage')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { id } = await params
  const { data: tpl } = await supabase
    .from('contract_templates')
    .select('id, slug, status')
    .eq('id', id)
    .eq('organization_id', profile.organization_id)
    .maybeSingle()
  if (!tpl) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (tpl.status === 'published') {
    return NextResponse.json({ ok: true, already_published: true })
  }

  // Archive currently-published for this slug
  await supabase
    .from('contract_templates')
    .update({ status: 'archived' })
    .eq('organization_id', profile.organization_id)
    .eq('slug', tpl.slug)
    .eq('status', 'published')

  const { error } = await supabase
    .from('contract_templates')
    .update({
      status: 'published',
      published_at: new Date().toISOString(),
      published_by: user.id,
    })
    .eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
