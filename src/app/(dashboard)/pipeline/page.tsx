import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { PipelineBoard } from '@/components/crm/pipeline-board'
import { decryptLeadsPII } from '@/lib/encryption'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { isFocusedStaff } from '@/lib/auth/permissions'
import { computeCloseBaseRate, scoreCloseProbability } from '@/lib/pipeline/close-probability'
import { suggestStageMove, type StageSuggestion } from '@/lib/pipeline/suggest-stage'

export default async function PipelinePage() {
  const supabase = await createClient()

  // Effective org honors an agency_admin's entered client account (see
  // resolveActiveOrg); falls back to the caller's home org otherwise.
  const { orgId, role } = await resolveActiveOrg(supabase)
  if (!orgId) return null

  // The pipeline kanban is a whole-book, PII-heavy surface. Focused (clinical)
  // staff get the Today view instead — they open one patient at a time.
  if (isFocusedStaff(role || 'member')) redirect('/dashboard')

  // Fetch pipeline stages
  const { data: stages } = await supabase
    .from('pipeline_stages')
    .select('*')
    .eq('organization_id', orgId)
    .order('position', { ascending: true })

  const allStages = stages || []

  // A whole practice book is tens of thousands of leads — you can neither render
  // that many cards nor trust a single capped fetch (PostgREST's default row cap
  // silently truncated the old `.select('*')`, so column headers counted only
  // the top slice by ai_score — e.g. "New Lead 779" against a real 25k). Instead:
  // one bounded, ai_score-ordered card fetch PER stage, each carrying its OWN
  // exact total (`count`) that honors the same status filter. The header shows
  // the true total; only up to CARD_CAP cards are actually rendered/dragged.
  const CARD_CAP = 80
  const perStage = await Promise.all(
    allStages.map(async (s) => {
      const { data, count } = await supabase
        .from('leads')
        .select('*', { count: 'exact' })
        .eq('organization_id', orgId)
        .eq('stage_id', s.id)
        .not('status', 'in', '("disqualified","lost")')
        .order('ai_score', { ascending: false })
        .range(0, CARD_CAP - 1)
      return { stageId: s.id, rows: data || [], count: count ?? 0 }
    })
  )

  // True per-stage totals for the column headers (decoupled from rendered cards).
  const stageCounts: Record<string, number> = {}
  for (const p of perStage) stageCounts[p.stageId] = p.count

  // Rendered card set = the union of every stage's capped slice.
  // PII is encrypted at rest — decrypt server-side before rendering.
  const allLeads = decryptLeadsPII(perStage.flatMap((p) => p.rows))
  const nowMs = Date.now()
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
      <PipelineBoard
        stages={allStages}
        leads={allLeads}
        stageCounts={stageCounts}
        probabilityByLead={probabilityByLead}
        suggestionByLead={suggestionByLead}
      />
    </div>
  )
}
