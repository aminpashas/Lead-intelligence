import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// GET /api/reactivation/[id]/stats — Real-time stats
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

  const { data: reactivation } = await supabase
    .from('reactivation_campaigns')
    .select('*, offers:reactivation_offers(*)')
    .eq('id', id)
    .eq('organization_id', profile.organization_id)
    .single()

  if (!reactivation) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Get enrollment data from underlying campaign
  let enrollmentBreakdown = {
    total: 0,
    active: 0,
    completed: 0,
    exited: 0,
    unsubscribed: 0,
  }

  let stepStats: Array<{
    step_number: number
    name: string
    channel: string
    total_sent: number
    total_delivered: number
    total_opened: number
    total_replied: number
  }> = []

  if (reactivation.campaign_id) {
    // Enrollment breakdown
    const { data: enrollments } = await supabase
      .from('campaign_enrollments')
      .select('status')
      .eq('campaign_id', reactivation.campaign_id)

    if (enrollments) {
      enrollmentBreakdown = {
        total: enrollments.length,
        active: enrollments.filter(e => e.status === 'active').length,
        completed: enrollments.filter(e => e.status === 'completed').length,
        exited: enrollments.filter(e => e.status === 'exited').length,
        unsubscribed: enrollments.filter(e => e.status === 'unsubscribed').length,
      }
    }

    // Per-step stats
    const { data: steps } = await supabase
      .from('campaign_steps')
      .select('step_number, name, channel, total_sent, total_delivered, total_opened, total_replied')
      .eq('campaign_id', reactivation.campaign_id)
      .order('step_number')

    if (steps) {
      stepStats = steps
    }
  }

  return NextResponse.json({
    campaign: reactivation,
    enrollments: enrollmentBreakdown,
    step_stats: stepStats,
    funnel: {
      uploaded: reactivation.total_uploaded || 0,
      enrolled: enrollmentBreakdown.total,
      contacted: stepStats.reduce((s, st) => s + (st.total_sent || 0), 0),
      responded: reactivation.total_responded || 0,
      reactivated: reactivation.total_reactivated || 0,
      converted: reactivation.total_converted || 0,
    },
  })
}
