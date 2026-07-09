import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { PipelineBoard } from '@/components/crm/pipeline-board'
import { PipelineRecommendations } from '@/components/crm/pipeline-recommendations'
import { decryptLeadsPII } from '@/lib/encryption'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { isFocusedStaff } from '@/lib/auth/permissions'
import { computeCloseBaseRate, scoreCloseProbability } from '@/lib/pipeline/close-probability'
import { suggestStageMove, type StageSuggestion } from '@/lib/pipeline/suggest-stage'
import { isPostCloseStage, isOperationalStage, isOffFunnelStage } from '@/lib/pipeline/stage-groups'
import { gatherPipelineSignals } from '@/lib/pipeline/pipeline-signals'
import { buildRecommendations } from '@/lib/pipeline/recommendations'
import { SERVICE_LINES, serviceLineOrFilter } from '@/lib/leads/service-line'

export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>
}) {
  const params = await searchParams
  const supabase = await createClient()

  // Effective org honors an agency_admin's entered client account (see
  // resolveActiveOrg); falls back to the caller's home org otherwise.
  const { orgId, role } = await resolveActiveOrg(supabase)
  if (!orgId) return null

  // Active treatment filter lives in the URL (?service=tmj), so clicking a chip
  // is a real server round-trip that re-scopes the whole board — not a filter of
  // the already-loaded ≤CARD_CAP sample (which is why "Implants" used to show 2
  // against a 48k book). Ignore unknown service keys.
  const serviceOr = params.service ? serviceLineOrFilter(params.service) : null
  const activeService = serviceOr ? params.service : null

  // The pipeline kanban is a whole-book, PII-heavy surface. Focused (clinical)
  // staff get the Today view instead — they open one patient at a time.
  if (isFocusedStaff(role || 'member')) redirect('/dashboard')

  // Fetch pipeline stages
  const { data: stages } = await supabase
    .from('pipeline_stages')
    .select('*')
    .eq('organization_id', orgId)
    .order('position', { ascending: true })

  // The sales Pipeline is the PRE-close funnel only. Post-close fulfillment
  // stages (Contract Signed → Scheduled for Treatment → Completed) are their own
  // board at /post-close, and off-funnel parking stages (Existing Patient, Junk)
  // hold non-leads — neither belongs on the sales funnel.
  const allStages = (stages || []).filter(
    (s) => !isPostCloseStage(s.slug) && !isOffFunnelStage(s.slug),
  )

  // A whole practice book is tens of thousands of leads — you can neither render
  // that many cards nor trust a single capped fetch (PostgREST's default row cap
  // silently truncated the old `.select('*')`, so column headers counted only
  // the top slice by ai_score — e.g. "New Lead 779" against a real 25k). Instead:
  // one bounded, ai_score-ordered card fetch PER stage, each carrying its OWN
  // exact total (`count`). The header shows the true total; only up to CARD_CAP
  // cards are actually rendered/dragged.
  const CARD_CAP = 80
  const perStage = await Promise.all(
    allStages.map(async (s) => {
      // Operational columns (No Communication, DND SMS, Nurturing) are work-queue
      // buckets, not sales positions — their population is orthogonal to sales
      // status. Applying the disqualified/lost filter to them hid ~8k
      // never-contacted leads from "No Communication". Sales stages keep the
      // filter so dead leads don't inflate the active funnel.
      const excludeDead = !isOperationalStage(s.slug)

      // Cards (+ exact total) honoring the active treatment filter, so a filtered
      // board renders that treatment's real leads instead of whatever slice of
      // the sample happened to match.
      let q = supabase
        .from('leads')
        .select('*', { count: 'exact' })
        .eq('organization_id', orgId)
        .eq('stage_id', s.id)
      if (excludeDead) q = q.not('status', 'in', '("disqualified","lost")')
      if (serviceOr) q = q.or(serviceOr)
      const { data, count } = await q
        .order('ai_score', { ascending: false })
        .range(0, CARD_CAP - 1)

      // Unfiltered stage total feeds the "All" grand total. Without a treatment
      // filter `count` already IS the unfiltered total — skip the extra query.
      let total = count ?? 0
      if (serviceOr) {
        let tq = supabase
          .from('leads')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', orgId)
          .eq('stage_id', s.id)
        if (excludeDead) tq = tq.not('status', 'in', '("disqualified","lost")')
        const { count: unfiltered } = await tq
        total = unfiltered ?? 0
      }
      return { stageId: s.id, rows: data || [], count: count ?? 0, total }
    })
  )

  // Per-stage totals for the column headers — treatment-filtered when a service
  // is active (headers reflect the filtered view); the grand total sums the
  // UNFILTERED per-stage totals so the "All" chip always shows the whole book.
  const stageCounts: Record<string, number> = {}
  let totalLeadCount = 0
  for (const p of perStage) {
    stageCounts[p.stageId] = p.count
    totalLeadCount += p.total
  }

  // Full-book per-service counts for the chip row — one exact head-count per
  // service line across the board's sales stages, so the chips reflect the real
  // book instead of the loaded card sample. (Excludes disqualified/lost, matching
  // the sales-stage rule; a chip counts the active funnel for that treatment.)
  const boardStageIds = allStages.map((s) => s.id)
  const serviceEntries = await Promise.all(
    SERVICE_LINES.map(async ({ key }) => {
      const or = serviceLineOrFilter(key)
      if (!or || boardStageIds.length === 0) return [key, 0] as const
      const { count } = await supabase
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId)
        .in('stage_id', boardStageIds)
        .not('status', 'in', '("disqualified","lost")')
        .or(or)
      return [key, count ?? 0] as const
    })
  )
  const serviceCounts: Record<string, number> = Object.fromEntries(serviceEntries)

  // Rendered card set = the union of every stage's capped slice.
  // PII is encrypted at rest — decrypt server-side before rendering.
  const allLeads = decryptLeadsPII(perStage.flatMap((p) => p.rows))
  const nowMs = Date.now()

  // Board-level AI recommendations (Google/Meta-Ads-style band). Computed from
  // cheap aggregate COUNT signals over the whole book — deliberately NOT the
  // capped card sample above — so a suggestion like "142 cooling leads" reflects
  // the real population, and its count matches what Apply will target.
  const signals = await gatherPipelineSignals(supabase, orgId, allStages, serviceOr, nowMs)
  const recommendations = buildRecommendations(signals)
  const baseRate = computeCloseBaseRate(allLeads.map((l) => l.status))
  const probabilityByLead: Record<string, number> = {}
  const suggestionByLead: Record<string, StageSuggestion> = {}
  for (const l of allLeads) {
    const p = scoreCloseProbability(l, baseRate, nowMs)
    probabilityByLead[l.id] = p
    const s = suggestStageMove(l, p, allStages)
    if (s) suggestionByLead[l.id] = s
  }

  return (
    <div className="h-full animate-in fade-in-0 duration-500">
      <header className="mb-6 border-b border-aurea-border pb-6">
        <p className="aurea-eyebrow mb-2">Sales Pipeline</p>
        <h1 className="aurea-display text-[32px] text-aurea-ink sm:text-[40px]">Pipeline</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-aurea-ink-2">
          Drag leads between stages to update their status
        </p>
      </header>
      <PipelineRecommendations recommendations={recommendations} />
      <PipelineBoard
        stages={allStages}
        leads={allLeads}
        stageCounts={stageCounts}
        totalLeadCount={totalLeadCount}
        serviceCounts={serviceCounts}
        activeService={activeService}
        probabilityByLead={probabilityByLead}
        suggestionByLead={suggestionByLead}
      />
    </div>
  )
}
