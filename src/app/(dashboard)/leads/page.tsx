import { createClient } from '@/lib/supabase/server'
import { LeadsTable } from '@/components/crm/leads-table'
import { LeadCSVImport } from '@/components/crm/lead-csv-import'
import { NewLeadDialog } from '@/components/crm/new-lead-dialog'
import type { Tag } from '@/types/database'
import { redirect } from 'next/navigation'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { isFocusedStaff } from '@/lib/auth/permissions'
import { decryptLeadsPII, searchHash } from '@/lib/encryption'
import { SERVICE_KEYWORDS } from '@/lib/leads/service-line'
import { resolveLeadDateRange } from '@/lib/leads/date-range'

// URL sort key → leads column, whitelisted so the param can't order by
// arbitrary (e.g. encrypted) columns.
const SORT_COLUMNS: Record<string, string> = {
  name: 'first_name',
  score: 'ai_score',
  value: 'treatment_value',
  created: 'created_at',
  // engagement_score is the purpose-built activity metric (message volume +
  // responsiveness). Populated once a lead is actually worked; today the 45k
  // imported book is all zeros, so this sort is dormant but correct.
  activity: 'engagement_score',
}

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
  const { orgId, role } = await resolveActiveOrg(supabase)
  if (!orgId) return null

  // The full lead book (45k rows) is not a focused-staff surface — they reach a
  // single patient from a consult or conversation. Send them to the Today view.
  if (isFocusedStaff(role || 'member')) redirect('/dashboard')

  // Fetch leads — sort column/direction come from the URL (whitelisted above).
  const sortCol = SORT_COLUMNS[params.sort] || 'created_at'
  const ascending = params.dir === 'asc'

  let query = supabase
    .from('leads')
    .select('*, pipeline_stage:pipeline_stages(*), source:lead_sources(*)', { count: 'exact' })
    .eq('organization_id', orgId)
    .order(sortCol, { ascending, nullsFirst: false })

  if (params.status) {
    query = query.in('status', params.status.split(','))
  }
  if (params.qualification) {
    query = query.eq('ai_qualification', params.qualification)
  }
  if (params.source) {
    query = query.eq('source_type', params.source)
  }
  if (params.credit) {
    query = query.eq('credit_range', params.credit)
  }
  if (params.range) {
    // Calendar-day windows in the practice tz (see lib/leads/date-range).
    const bounds = resolveLeadDateRange(params.range)
    if (bounds) {
      query = query.gte('created_at', bounds.gte)
      if (bounds.lt) query = query.lt('created_at', bounds.lt)
    }
  }
  if (params.campaign) {
    // Campaign names contain commas/brackets — PostgREST needs them quoted
    // inside .or(); strip quote/backslash so the value can't break out.
    const v = params.campaign.replace(/["\\]/g, '')
    query = query.or(`campaign_attribution->>campaign_name.eq."${v}",utm_campaign.eq."${v}"`)
  }
  if (params.service && SERVICE_KEYWORDS[params.service]) {
    const conds: string[] = []
    if (params.service === 'implants') conds.push('custom_fields->>treatment_interest.eq.implant')
    if (params.service === 'tmj' || params.service === 'sleep_apnea') {
      conds.push(`custom_fields->>treatment_interest.eq.${params.service}`)
      conds.push(`tags.cs.{${params.service}}`)
    }
    for (const kw of SERVICE_KEYWORDS[params.service]) {
      for (const field of ['utm_campaign', 'utm_source', 'campaign_attribution->>campaign_name']) {
        conds.push(`${field}.ilike.%${kw}%`)
      }
    }
    query = query.or(conds.join(','))
  }
  if (params.search) {
    // email/phone are encrypted at rest — ilike can't match ciphertext, so
    // exact-match those via their deterministic search hashes instead.
    const hash = searchHash(params.search)
    query = query.or(
      `first_name.ilike.%${params.search}%,last_name.ilike.%${params.search}%,email_hash.eq.${hash},phone_hash.eq.${hash}`
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

  const { data: leadRows, count } = await query

  // PII (email/phone/etc.) is encrypted at rest — decrypt server-side before
  // handing rows to the client component, or the table renders `enc::…` blobs.
  const leads = decryptLeadsPII(leadRows || [])

  // Fetch pipeline stages for filters
  const { data: stages } = await supabase
    .from('pipeline_stages')
    .select('*')
    .eq('organization_id', orgId)
    .order('position')

  // Distinct source/campaign values (with counts) for the filter dropdowns —
  // aggregated in the DB (RPC runs under the caller's RLS).
  const { data: facets } = await supabase.rpc('leads_filter_facets', { p_org: orgId })
  const sourceFacets = (facets?.source_types ?? []) as { value: string; count: number }[]
  const campaignFacets = (facets?.campaigns ?? []) as { value: string; count: number }[]
  // Credit buckets only appear once discovery captures them — empty today, so
  // the dropdown stays hidden (facet-gated in the table, like source/campaign).
  const creditFacets = (facets?.credit_ranges ?? []) as { value: string; count: number }[]

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
        leads={leads}
        stages={stages || []}
        total={count || 0}
        page={page}
        perPage={perPage}
        allTags={allTags || []}
        leadTagsMap={leadTagsMap}
        sourceFacets={sourceFacets}
        campaignFacets={campaignFacets}
        creditFacets={creditFacets}
      />
    </div>
  )
}
