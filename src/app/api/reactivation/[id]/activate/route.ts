import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requirePermission } from '@/lib/auth/active-org'

// POST /api/reactivation/[id]/activate — Activate the reactivation campaign
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  // Activating a reactivation campaign is agency-side.
  const guard = await requirePermission(supabase, 'reactivation:write')
  if ('error' in guard) return guard.error
  const { orgId } = guard

  // Get the reactivation campaign
  const { data: reactivation } = await supabase
    .from('reactivation_campaigns')
    .select('*')
    .eq('id', id)
    .eq('organization_id', orgId)
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
