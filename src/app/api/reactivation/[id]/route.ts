import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// GET /api/reactivation/[id] - Get campaign details
export async function GET(
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

  const { data, error } = await supabase
    .from('reactivation_campaigns')
    .select('*, offers:reactivation_offers(*)')
    .eq('id', id)
    .eq('organization_id', profile.organization_id)
    .single()

  if (error || !data) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Get underlying campaign with steps if it exists
  let campaignWithSteps = null
  if (data.campaign_id) {
    const { data: campaign } = await supabase
      .from('campaigns')
      .select('*, steps:campaign_steps(*)')
      .eq('id', data.campaign_id)
      .single()
    campaignWithSteps = campaign
  }

  // Get enrollment stats
  let enrollmentStats = { total: 0, active: 0, completed: 0, exited: 0 }
  if (data.campaign_id) {
    const { data: enrollments } = await supabase
      .from('campaign_enrollments')
      .select('status')
      .eq('campaign_id', data.campaign_id)

    if (enrollments) {
      enrollmentStats = {
        total: enrollments.length,
        active: enrollments.filter(e => e.status === 'active').length,
        completed: enrollments.filter(e => e.status === 'completed').length,
        exited: enrollments.filter(e => e.status === 'exited').length,
      }
    }
  }

  return NextResponse.json({
    campaign: data,
    underlying_campaign: campaignWithSteps,
    enrollment_stats: enrollmentStats,
  })
}

// PATCH /api/reactivation/[id] - Update campaign
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const body = await request.json()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Only allow updating certain fields
  const allowedFields: Record<string, unknown> = {}
  const editableFields = ['name', 'description', 'goal', 'tone', 'channel', 'ai_hooks', 'engagement_rules', 'status']
  for (const field of editableFields) {
    if (body[field] !== undefined) {
      allowedFields[field] = body[field]
    }
  }

  const { data, error } = await supabase
    .from('reactivation_campaigns')
    .update(allowedFields)
    .eq('id', id)
    .eq('organization_id', profile.organization_id)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ campaign: data })
}

// DELETE /api/reactivation/[id] - Archive campaign
export async function DELETE(
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

  const { error } = await supabase
    .from('reactivation_campaigns')
    .update({ status: 'archived' })
    .eq('id', id)
    .eq('organization_id', profile.organization_id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
