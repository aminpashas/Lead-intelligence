import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requirePermission } from '@/lib/auth/active-org'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  // Activating a campaign is agency-side. Effective org honors agency
  // acting-as (matches RLS get_user_org_id()).
  const guard = await requirePermission(supabase, 'campaigns:write')
  if ('error' in guard) return guard.error
  const { orgId } = guard

  const { data: campaign, error } = await supabase
    .from('campaigns')
    .update({ status: 'active', start_at: new Date().toISOString() })
    .eq('id', id)
    .eq('organization_id', orgId) // Defense-in-depth: explicit org scoping
    .select()
    .single()

  if (error || !campaign) {
    return NextResponse.json({ error: error?.message || 'Campaign not found' }, { status: error ? 500 : 404 })
  }

  return NextResponse.json({ campaign })
}

