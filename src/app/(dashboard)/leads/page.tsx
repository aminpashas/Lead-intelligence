import { createClient } from '@/lib/supabase/server'
import { LeadsTable } from '@/components/crm/leads-table'
import { LeadCSVImport } from '@/components/crm/lead-csv-import'
import { NewLeadDialog } from '@/components/crm/new-lead-dialog'
import type { Tag } from '@/types/database'

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>
}) {
  const params = await searchParams
  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) return null

  // Fetch leads
  let query = supabase
    .from('leads')
    .select('*, pipeline_stage:pipeline_stages(*), source:lead_sources(*)', { count: 'exact' })
    .eq('organization_id', profile.organization_id)
    .order('created_at', { ascending: false })

  if (params.status) {
    query = query.in('status', params.status.split(','))
  }
  if (params.qualification) {
    query = query.eq('ai_qualification', params.qualification)
  }
  if (params.search) {
    query = query.or(
      `first_name.ilike.%${params.search}%,last_name.ilike.%${params.search}%,email.ilike.%${params.search}%,phone.ilike.%${params.search}%`
    )
  }

  // Tag filtering — look up lead IDs with this tag
  let tagFilteredLeadIds: string[] | null = null
  if (params.tag) {
    const { data: tagRow } = await supabase
      .from('tags')
      .select('id')
      .eq('organization_id', profile.organization_id)
      .eq('slug', params.tag)
      .single()

    if (tagRow) {
      const { data: leadTags } = await supabase
        .from('lead_tags')
        .select('lead_id')
        .eq('tag_id', tagRow.id)
        .eq('organization_id', profile.organization_id)

      tagFilteredLeadIds = (leadTags || []).map((lt) => lt.lead_id)
      if (tagFilteredLeadIds.length > 0) {
        query = query.in('id', tagFilteredLeadIds)
      } else {
        // No leads match this tag
        return (
          <div>
            <div className="mb-6 flex items-center justify-between">
              <div>
                <h1 className="text-2xl font-bold">Leads</h1>
                <p className="text-muted-foreground">0 total leads</p>
              </div>
              <div className="flex items-center gap-2">
                <LeadCSVImport />
                <NewLeadDialog />
              </div>
            </div>
            <LeadsTable leads={[]} stages={[]} total={0} page={1} perPage={50} />
          </div>
        )
      }
    }
  }

  const page = parseInt(params.page || '1')
  const perPage = 50
  query = query.range((page - 1) * perPage, page * perPage - 1)

  const { data: leads, count } = await query

  // Fetch pipeline stages for filters
  const { data: stages } = await supabase
    .from('pipeline_stages')
    .select('*')
    .eq('organization_id', profile.organization_id)
    .order('position')

  // Fetch all tags for the filter dropdown
  const { data: allTags } = await supabase
    .from('tags')
    .select('*')
    .eq('organization_id', profile.organization_id)
    .order('name')

  // Fetch lead tags for displayed leads
  const leadIds = (leads || []).map((l: any) => l.id)
  let leadTagsMap: Record<string, Tag[]> = {}

  if (leadIds.length > 0) {
    const { data: leadTagRows } = await supabase
      .from('lead_tags')
      .select('lead_id, tag:tags(*)')
      .in('lead_id', leadIds)
      .eq('organization_id', profile.organization_id)

    if (leadTagRows) {
      for (const row of leadTagRows) {
        if (!leadTagsMap[row.lead_id]) leadTagsMap[row.lead_id] = []
        if (row.tag) leadTagsMap[row.lead_id].push(row.tag as any)
      }
    }
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Leads</h1>
          <p className="text-muted-foreground">
            {count || 0} total leads
          </p>
        </div>
        <div className="flex items-center gap-2">
          <LeadCSVImport />
          <NewLeadDialog />
        </div>
      </div>

      <LeadsTable
        leads={leads || []}
        stages={stages || []}
        total={count || 0}
        page={page}
        perPage={perPage}
        allTags={allTags || []}
        leadTagsMap={leadTagsMap}
      />
    </div>
  )
}
