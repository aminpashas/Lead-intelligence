import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  // Auth + org scoping — effective org honors agency acting-as (matches RLS).
  const { orgId } = await resolveActiveOrg(supabase)

  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

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

