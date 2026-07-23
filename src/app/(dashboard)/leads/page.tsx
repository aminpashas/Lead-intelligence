import { createClient } from '@/lib/supabase/server'
import { LeadsTable } from '@/components/crm/leads-table'
import { LeadCSVImport } from '@/components/crm/lead-csv-import'
import { NewLeadDialog } from '@/components/crm/new-lead-dialog'
import type { Tag } from '@/types/database'
import { redirect } from 'next/navigation'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { isFocusedStaff } from '@/lib/auth/permissions'
import { decryptLeadsPII, searchHash } from '@/lib/encryption'
import { serviceLineOrFilter } from '@/lib/leads/service-line'
import { resolveLeadDateRange } from '@/lib/leads/date-range'
import { decodeFilterParam } from '@/lib/leads/filter-param'
import { resolveFilterTree } from '@/lib/campaigns/filter-tree'
import { PAID_AD_CHANNEL_OR_FILTER } from '@/lib/attribution'
import {
  applyDerivedFilter,
  isDerivedColumnKey,
  ACTIVE_COMMS_WINDOW_DAYS,
} from '@/lib/pipeline/derived-columns'
import { OFF_FUNNEL_STAGE_SLUGS } from '@/lib/pipeline/stage-groups'

// URL sort key → leads column, whitelisted so the param can't order by
// arbitrary (e.g. encrypted) columns.
const SORT_COLUMNS: Record<string, string> = {
  name: 'first_name',
  // The Engagement column sorts by the behavioral meter (engagement sweep),
  // not the AI quality grade — see src/lib/engagement/temperature.ts.
  score: 'engagement_score',
  value: 'treatment_value',
  created: 'created_at',
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

  // Off-funnel parking stages (existing patients, junk caller-ID calls) are NOT
  // sales leads — hide them from the default leads view so inbound-call noise
  // stops polluting the list. `?include=all` reveals them for triage/audit.
  if (params.include !== 'all') {
    const { data: offStages } = await supabase
      .from('pipeline_stages')
      .select('id')
      .eq('organization_id', orgId)
      .in('slug', OFF_FUNNEL_STAGE_SLUGS as unknown as string[])
    const offIds = (offStages ?? []).map((s) => s.id as string)
    if (offIds.length > 0) {
      query = query.not('stage_id', 'in', `(${offIds.join(',')})`)
    }
  }

  if (params.status) {
    query = query.in('status', params.status.split(','))
  }
  if (params.qualification) {
    query = query.eq('ai_qualification', params.qualification)
  }
  // Behavioral engagement temperature (hot/warm/cooling/new/cold) — the meter
  // the table's "Engagement" filter drives. Whitelisted values only; anything
  // else is ignored rather than passed to PostgREST.
  if (['hot', 'warm', 'cooling', 'new', 'cold'].includes(params.temp)) {
    query = query.eq('engagement_temperature', params.temp)
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
  // Paid-ad acquisition filter — the dashboard "New Ad Leads" / "Not Contacted"
  // KPIs count only genuine Meta/Google paid campaign leads (see attribution.ts).
  // `?channel=paid` lets those cards deep-link into the exact same cohort.
  if (params.channel === 'paid') {
    query = query.or(PAID_AD_CHANNEL_OR_FILTER)
  }
  // Speed-to-lead gap — leads nobody has reached out to yet (`last_contacted_at`
  // null). Pairs with `channel=paid` + `range` to reproduce the "Not Contacted" KPI.
  if (params.uncontacted === '1') {
    query = query.is('last_contacted_at', null)
  }
  // Recently-replied cohort for the "Replied · 7d" KPI: leads that responded to
  // us within the range window. Applies the cutoff to `last_responded_at` rather
  // than `created_at`; an unknown key falls back to "has ever replied".
  if (params.replied) {
    const bounds = resolveLeadDateRange(params.replied)
    if (bounds) query = query.gte('last_responded_at', bounds.gte)
    else query = query.not('last_responded_at', 'is', null)
  }
  if (params.campaign) {
    // Campaign names contain commas/brackets — PostgREST needs them quoted
    // inside .or(); strip quote/backslash so the value can't break out.
    const v = params.campaign.replace(/["\\]/g, '')
    query = query.or(`campaign_attribution->>campaign_name.eq."${v}",utm_campaign.eq."${v}"`)
  }
  if (params.service) {
    const or = serviceLineOrFilter(params.service)
    if (or) query = query.or(or)
  }
  // Derived "signal" filter — the deep-link target from the pipeline board's
  // read-only signal columns. Reuses the SAME predicate as those columns, so the
  // list here matches a column's header count exactly. Guarded because the key
  // comes from the URL (see isDerivedColumnKey).
  if (isDerivedColumnKey(params.signal)) {
    const cutoffIso = new Date(Date.now() - ACTIVE_COMMS_WINDOW_DAYS * 86_400_000).toISOString()
    query = applyDerivedFilter(query, params.signal, cutoffIso)
  }
  if (params.search) {
    // email/phone are encrypted at rest — ilike can't match ciphertext, so
    // exact-match those via their deterministic search hashes instead.
    const q = params.search.trim()
    const hash = searchHash(q)
    // Strip characters that have meaning in PostgREST's or()/and() grammar so
    // a value like "O'Brien, Amin" can't break out of the filter expression.
    const clean = (s: string) => s.replace(/[(),*%\\"]/g, '')
    const tokens = q.split(/\s+/).map(clean).filter(Boolean)

    // Names live in separate first_name/last_name columns, so the full string
    // ("Amin Samadian") never matches either column on its own. Match the whole
    // string (covers single-token + substring), plus require EACH token to
    // appear across first/last name so a full name narrows instead of missing.
    const conds = [
      `first_name.ilike.%${clean(q)}%`,
      `last_name.ilike.%${clean(q)}%`,
      `email_hash.eq.${hash}`,
      `phone_hash.eq.${hash}`,
    ]
    if (tokens.length > 1) {
      const perToken = tokens
        .map((t) => `or(first_name.ilike.%${t}%,last_name.ilike.%${t}%)`)
        .join(',')
      conds.push(`and(${perToken})`)
    }
    query = query.or(conds.join(','))
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

  // Advanced search — a nested AND/OR filter tree carried in the `af` URL param
  // (base64url JSON). Decode + validate against the field registry, resolve to
  // matching lead IDs via the shared engine, and intersect (same `.in('id', …)`
  // pattern as the tag filter above). A tampered/stale param fails closed to
  // null and is ignored rather than throwing.
  if (params.af) {
    const tree = decodeFilterParam(params.af)
    if (tree) {
      const treeSet = await resolveFilterTree(supabase, orgId, tree)
      const ids = [...treeSet].slice(0, 1000)
      // Empty match → a sentinel that matches nothing, so the list is empty
      // instead of silently unfiltered.
      query = query.in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000'])
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
  const leadTagsMap: Record<string, Tag[]> = {}

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
