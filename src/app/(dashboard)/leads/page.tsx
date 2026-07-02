import { createClient } from '@/lib/supabase/server'
import { LeadsTable } from '@/components/crm/leads-table'
import { decryptLeadsPII } from '@/lib/encryption'
import { LeadCSVImport } from '@/components/crm/lead-csv-import'
import { NewLeadDialog } from '@/components/crm/new-lead-dialog'
import type { Tag } from '@/types/database'
import { resolveActiveOrg } from '@/lib/auth/active-org'

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>
}) {
  const params = await searchParams
  const supabase = await createClient()

  // Resolve the effective org: an agency_admin who has "entered" a client
  // account operates on that client's org (via agency_active_org); everyone
  // else operates on their own home org. Filtering on the home org here was the
  // bug that made the Leads view empty for agency admins managing a practice.
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return null

  // Fetch leads
  let query = supabase
    .from('leads')
    .select('*, pipeline_stage:pipeline_stages(*), source:lead_sources(*)', { count: 'exact' })
    .eq('organization_id', orgId)
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
      .eq('organization_id', orgId)
      .eq('slug', params.tag)
      .single()

    if (tagRow) {
      const { data: leadTags } = await supabase
        .from('lead_tags')
        .select('lead_id')
        .eq('tag_id', tagRow.id)
        .eq('organization_id', orgId)

      tagFilteredLeadIds = (leadTags || []).map((lt) => lt.lead_id)
      if (tagFilteredLeadIds.length > 0) {
        query = query.in('id', tagFilteredLeadIds)
      } else {
        // No leads match this tag
        return (
          <div className="animate-in fade-in-0 duration-500">
            <header className="mb-8 flex flex-col gap-5 border-b border-aurea-border pb-8 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="aurea-eyebrow mb-3">Lead Management</p>
                <h1 className="aurea-display text-[40px] text-aurea-ink sm:text-[52px]">Leads</h1>
                <p className="mt-2 font-mono text-[13px] tabular-nums text-aurea-ink-3">0 total</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <LeadCSVImport />
                <NewLeadDialog />
              </div>
            </header>
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
    .eq('organization_id', orgId)
    .order('position')

  // Fetch all tags for the filter dropdown
  const { data: allTags } = await supabase
    .from('tags')
    .select('*')
    .eq('organization_id', orgId)
    .order('name')

  // Fetch lead tags for displayed leads
  const leadIds = (leads || []).map((l: any) => l.id)
  let leadTagsMap: Record<string, Tag[]> = {}

  if (leadIds.length > 0) {
    const { data: leadTagRows } = await supabase
      .from('lead_tags')
      .select('lead_id, tag:tags(*)')
      .in('lead_id', leadIds)
      .eq('organization_id', orgId)

    if (leadTagRows) {
      for (const row of leadTagRows) {
        if (!leadTagsMap[row.lead_id]) leadTagsMap[row.lead_id] = []
        if (row.tag) leadTagsMap[row.lead_id].push(row.tag as any)
      }
    }
  }

  return (
    <div className="animate-in fade-in-0 duration-500">
      <header className="mb-8 flex flex-col gap-5 border-b border-aurea-border pb-8 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="aurea-eyebrow mb-3">Lead Management</p>
          <h1 className="aurea-display text-[40px] text-aurea-ink sm:text-[52px]">Leads</h1>
          <p className="mt-2 font-mono text-[13px] tabular-nums text-aurea-ink-3">
            {(count || 0).toLocaleString()} total
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <LeadCSVImport />
          <NewLeadDialog />
        </div>
      </header>

      <LeadsTable
        leads={decryptLeadsPII(leads || [])}
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
