import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveSmartListLeads, applySmartListCriteria } from '@/lib/campaigns/smart-list-resolver'
import { decryptLeadsPII } from '@/lib/encryption'

// GET /api/smart-lists/:id/leads — Get leads matching this Smart List
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { searchParams } = new URL(request.url)

  const page = Math.max(1, parseInt(searchParams.get('page') || '1'))
  const perPage = Math.min(100, Math.max(1, parseInt(searchParams.get('per_page') || '50')))

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Fetch the Smart List
  const { data: smartList } = await supabase
    .from('smart_lists')
    .select('*')
    .eq('id', id)
    .eq('organization_id', profile.organization_id)
    .single()

  if (!smartList) {
    return NextResponse.json({ error: 'Smart List not found' }, { status: 404 })
  }

  const criteria = smartList.criteria

  // Resolve tag-filtered lead IDs first (if needed)
  let tagFilteredIds: string[] | null = null
  if (criteria.tags && criteria.tags.ids && criteria.tags.ids.length > 0) {
    const { leadIds } = await resolveSmartListLeads(
      supabase,
      profile.organization_id,
      { tags: criteria.tags },
      { limit: 10000 }
    )
    tagFilteredIds = leadIds
    if (tagFilteredIds.length === 0) {
      return NextResponse.json({
        leads: [],
        pagination: { page, per_page: perPage, total: 0, total_pages: 0 },
      })
    }
  }

  // Build the full leads query with joins
  let query = supabase
    .from('leads')
    .select('*, pipeline_stage:pipeline_stages(*), source:lead_sources(*)', { count: 'exact' })
    .eq('organization_id', profile.organization_id)

  // Apply tag filter
  if (tagFilteredIds) {
    query = query.in('id', tagFilteredIds.slice(0, 1000))
  }

  // Apply other criteria
  query = applySmartListCriteria(query, criteria)

  // Paginate
  const from = (page - 1) * perPage
  query = query
    .order('created_at', { ascending: false })
    .range(from, from + perPage - 1)

  const { data: leads, count, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Update cached count
  await supabase
    .from('smart_lists')
    .update({ lead_count: count || 0, last_refreshed_at: new Date().toISOString() })
    .eq('id', id)

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
