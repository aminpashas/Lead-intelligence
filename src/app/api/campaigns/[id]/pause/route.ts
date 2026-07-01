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

  // Verify campaign belongs to the effective org
  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  if (!campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
  }

  // Pause campaign — scoped to org
  await supabase
    .from('campaigns')
    .update({ status: 'paused' })
    .eq('id', id)
    .eq('organization_id', orgId)

  // Pause all active enrollments
  await supabase
    .from('campaign_enrollments')
    .update({ status: 'paused' })
    .eq('campaign_id', id)
    .eq('organization_id', orgId)
    .eq('status', 'active')

  return NextResponse.json({ success: true })
}

