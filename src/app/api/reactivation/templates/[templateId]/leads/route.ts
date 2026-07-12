import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { applySmartListCriteria } from '@/lib/campaigns/smart-list-resolver'
import { getTemplateAudienceCriteria } from '@/lib/campaigns/reactivation-audience'
import { decryptLeadsPII } from '@/lib/encryption'

// GET /api/reactivation/templates/:templateId/leads
// Smart-list-style audience preview: which leads would this template apply to?
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ templateId: string }> }
) {
  const { templateId } = await params
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const criteria = getTemplateAudienceCriteria(templateId)
  if (!criteria) {
    return NextResponse.json({ error: 'Unknown template' }, { status: 404 })
  }

  const { searchParams } = new URL(request.url)
  const page = Math.max(1, parseInt(searchParams.get('page') || '1'))
  const perPage = Math.min(100, Math.max(1, parseInt(searchParams.get('per_page') || '25')))

  let query = supabase
    .from('leads')
    .select(
      'id, first_name, last_name, email, phone_formatted, status, ai_score, ai_qualification, last_contacted_at, created_at',
      { count: 'exact' }
    )
    .eq('organization_id', orgId)

  query = applySmartListCriteria(query, criteria)

  const from = (page - 1) * perPage
  const { data: leads, count, error } = await query
    .order('created_at', { ascending: false })
    .range(from, from + perPage - 1)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    leads: decryptLeadsPII(leads || []),
    pagination: {
      page,
      per_page: perPage,
      total: count || 0,
      total_pages: Math.ceil((count || 0) / perPage),
    },
  })
}
