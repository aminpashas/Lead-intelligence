import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// POST /api/reactivation/[id]/activate — Activate the reactivation campaign
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Get the reactivation campaign
  const { data: reactivation } = await supabase
    .from('reactivation_campaigns')
    .select('*')
    .eq('id', id)
    .eq('organization_id', profile.organization_id)
    .single()

  if (!reactivation) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
  }

  // Activate the underlying campaign
  if (reactivation.campaign_id) {
    await supabase
      .from('campaigns')
      .update({ status: 'active' })
      .eq('id', reactivation.campaign_id)
  }

  // Activate the reactivation campaign
  const { data, error } = await supabase
    .from('reactivation_campaigns')
    .update({ status: 'active' })
    .eq('id', id)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ campaign: data })
}
