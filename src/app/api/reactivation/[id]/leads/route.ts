import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { decryptLeadsPII } from '@/lib/encryption'

// GET /api/reactivation/:id/leads
// Leads actually enrolled in this reactivation campaign (via the underlying
// campaign's enrollments), paginated.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: reactivation } = await supabase
    .from('reactivation_campaigns')
    .select('id, campaign_id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  if (!reactivation) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const { searchParams } = new URL(request.url)
  const page = Math.max(1, parseInt(searchParams.get('page') || '1'))
  const perPage = Math.min(100, Math.max(1, parseInt(searchParams.get('per_page') || '25')))

  if (!reactivation.campaign_id) {
    return NextResponse.json({
      leads: [],
      pagination: { page, per_page: perPage, total: 0, total_pages: 0 },
    })
  }

  const from = (page - 1) * perPage
  const { data: enrollments, count, error } = await supabase
    .from('campaign_enrollments')
    .select(
      'status, current_step, created_at, lead:leads(id, first_name, last_name, email, phone_formatted, status, ai_score, ai_qualification, last_contacted_at, created_at)',
      { count: 'exact' }
    )
    .eq('campaign_id', reactivation.campaign_id)
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })
    .range(from, from + perPage - 1)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Flatten to the same shape the template-audience endpoint returns, with
  // enrollment status attached so the panel can show where each lead is.
  const leads: Record<string, unknown>[] = []
  for (const e of enrollments || []) {
    const lead = e.lead as unknown as Record<string, unknown> | null
    if (!lead) continue
    leads.push({
      ...lead,
      enrollment_status: e.status,
      enrollment_step: e.current_step,
    })
  }

  return NextResponse.json({
    leads: decryptLeadsPII(leads),
    pagination: {
      page,
      per_page: perPage,
      total: count || 0,
      total_pages: Math.ceil((count || 0) / perPage),
    },
  })
}
