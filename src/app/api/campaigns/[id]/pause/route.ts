import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  // Auth + org scoping
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Verify campaign belongs to user's org
  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id')
    .eq('id', id)
    .eq('organization_id', profile.organization_id)
    .single()

  if (!campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
  }

  // Pause campaign — scoped to org
  await supabase
    .from('campaigns')
    .update({ status: 'paused' })
    .eq('id', id)
    .eq('organization_id', profile.organization_id)

  // Pause all active enrollments
  await supabase
    .from('campaign_enrollments')
    .update({ status: 'paused' })
    .eq('campaign_id', id)
    .eq('organization_id', profile.organization_id)
    .eq('status', 'active')

  return NextResponse.json({ success: true })
}

