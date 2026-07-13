import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { PipelineBoard } from '@/components/crm/pipeline-board'
import { PipelineRecommendations } from '@/components/crm/pipeline-recommendations'
import { decryptLeadsPII } from '@/lib/encryption'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { isFocusedStaff } from '@/lib/auth/permissions'
import {
  computeCloseBaseRate,
  scoreCloseProbability,
  readStampedCloseProbability,
  type StampedCloseProbability,
} from '@/lib/pipeline/close-probability'
import { suggestStageMove, type StageSuggestion } from '@/lib/pipeline/suggest-stage'
import { isPostCloseStage, isOperationalStage, isActiveContactStage, isOffFunnelStage } from '@/lib/pipeline/stage-groups'
import { gatherPipelineSignals } from '@/lib/pipeline/pipeline-signals'
import { buildRecommendations, type Recommendation } from '@/lib/pipeline/recommendations'
import { listOpenRecommendations } from '@/lib/pipeline/recommendation-store'
import {
  DERIVED_COLUMNS,
  ACTIVE_COMMS_WINDOW_DAYS,
  applyDerivedFilter,
} from '@/lib/pipeline/derived-columns'
import { PipelineSignalColumns } from '@/components/crm/pipeline-signal-columns'
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
      // created_at is a deterministic tiebreaker: when a stage's leads share an
      // ai_score (New Lead is entirely ai_score=0 until the score-sweep runs), a
      // sole ai_score sort is a total tie and Postgres returns an arbitrary,
      // unstable 80-row slice — so freshly-arrived leads never surfaced as cards
      // even though the header counted them. Freshest-first within a tie makes
      // "New Lead" actually show the newest leads.
      const { data, count } = await q
        .order('ai_score', { ascending: false })
        .order('created_at', { ascending: false })
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

  // Following Up / Engaged cards show a Day-N cadence badge sourced from the
  // lead's follow_up_enrollments row. Scope the fetch to just those two
  // stages' rendered leads — no need to touch enrollments for the rest of the
  // board.
  const activeContactStageIds = new Set(
    allStages.filter((s) => isActiveContactStage(s.slug)).map((s) => s.id)
  )
  const activeContactLeadIds = allLeads
    .filter((l) => l.stage_id && activeContactStageIds.has(l.stage_id))
    .map((l) => l.id)

  const enrollments: Record<
    string,
    { status: 'active' | 'completed' | 'stopped'; current_step: number; enrolled_at: string }
  > = {}
  if (activeContactLeadIds.length > 0) {
    const { data: enr } = await supabase
      .from('follow_up_enrollments')
      .select('lead_id, status, current_step, enrolled_at')
      .eq('organization_id', orgId)
      .in('lead_id', activeContactLeadIds)
    for (const e of enr || []) {
      enrollments[e.lead_id] = {
        status: e.status,
        current_step: e.current_step,
        enrolled_at: e.enrolled_at,
      }
    }
  }

  // Board-level AI recommendations (Google/Meta-Ads-style band). Preferred
  // source: the PERSISTED rows the hourly pipeline-recommendations cron writes
  // (rules engine + LLM-analyst reranks/insights, with server-side
  // apply/dismiss status) — one indexed read instead of a whole-book count
  // fan-out. Fallback when no persisted rows exist yet (new org, cron hasn't
  // run, rows expired): live compute exactly as before. Persisted rows are
  // whole-book, so an active treatment chip always live-computes — the band
  // must describe the same filtered population as the board it sits on.
  let recommendations: Recommendation[] = serviceOr
    ? []
    : await listOpenRecommendations(supabase, orgId, nowMs)
  if (recommendations.length === 0) {
    // Live path: cheap aggregate COUNT signals over the whole book —
    // deliberately NOT the capped card sample above — so a suggestion like
    // "142 cooling leads" reflects the real population, and its count matches
    // what Apply will target.
    const signals = await gatherPipelineSignals(supabase, orgId, allStages, serviceOr, nowMs)
    recommendations = buildRecommendations(signals)
  }

  const baseRate = computeCloseBaseRate(allLeads.map((l) => l.status))
  const probabilityByLead: Record<string, number> = {}
  const suggestionByLead: Record<string, StageSuggestion> = {}
  for (const l of allLeads) {
    // Prefer the cron-stamped CALIBRATED probability (calibrate-scoring writes
    // leads.close_probability weekly) when fresh; fall back to the live
    // heuristic for never-stamped or stale leads.
    const p =
      readStampedCloseProbability(l as StampedCloseProbability, nowMs) ??
      scoreCloseProbability(l, baseRate, nowMs)
    probabilityByLead[l.id] = p
    const s = suggestStageMove(l, p, allStages)
    if (s) suggestionByLead[l.id] = s
  }

  // Derived "signal" columns — honest, read-only lenses computed from real lead
  // activity (contacted-ness, reply recency, financial assessment) instead of the
  // stale GHL stage label that makes "New Lead" read 10k. Each is one exact,
  // whole-book, treatment-aware count plus a capped card slice, scoped to the
  // board's (pre-close) stages. Cheap COUNT + a small card fetch per column.
  const SIGNAL_CARD_CAP = 40
  const signalCutoffIso = new Date(nowMs - ACTIVE_COMMS_WINDOW_DAYS * 86_400_000).toISOString()
  const signalColumns = await Promise.all(
    DERIVED_COLUMNS.map(async (col) => {
      // Exact whole-book count for the header (head:true = count only, no rows).
      let cq = supabase
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId)
        .in('stage_id', boardStageIds)
      cq = applyDerivedFilter(cq, col.key, signalCutoffIso)
      if (serviceOr) cq = cq.or(serviceOr)
      const { count } = await cq

      // Top cards by ai_score — same predicate, so cards ⊆ the counted set.
      let dq = supabase
        .from('leads')
        .select('*')
        .eq('organization_id', orgId)
        .in('stage_id', boardStageIds)
      dq = applyDerivedFilter(dq, col.key, signalCutoffIso)
      if (serviceOr) dq = dq.or(serviceOr)
      // Same tie-break as the stage columns above — freshest-first so a bucket of
      // equally-scored leads renders its newest cards, not an arbitrary slice.
      const { data } = await dq
        .order('ai_score', { ascending: false })
        .order('created_at', { ascending: false })
        .range(0, SIGNAL_CARD_CAP - 1)

      // "View all" deep-links into /leads with the same signal filter (and the
      // active treatment, so a filtered board's links stay filtered).
      const linkParams = new URLSearchParams({ signal: col.key })
      if (activeService) linkParams.set('service', activeService)

      return {
        key: col.key,
        label: col.label,
        description: col.description,
        count: count ?? 0,
        leads: decryptLeadsPII(data || []),
        href: `/leads?${linkParams.toString()}`,
      }
    })
  )

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
      <PipelineSignalColumns columns={signalColumns} />
      <PipelineBoard
        stages={allStages}
        leads={allLeads}
        stageCounts={stageCounts}
        totalLeadCount={totalLeadCount}
        serviceCounts={serviceCounts}
        activeService={activeService}
        probabilityByLead={probabilityByLead}
        suggestionByLead={suggestionByLead}
        enrollments={enrollments}
      />
    </div>
  )
}
