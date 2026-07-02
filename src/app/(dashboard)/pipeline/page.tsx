import { createClient } from '@/lib/supabase/server'
import { PipelineBoard } from '@/components/crm/pipeline-board'
import { decryptLeadsPII } from '@/lib/encryption'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { computeCloseBaseRate, scoreCloseProbability } from '@/lib/pipeline/close-probability'
import { suggestStageMove, type StageSuggestion } from '@/lib/pipeline/suggest-stage'

export default async function PipelinePage() {
  const supabase = await createClient()

  // Effective org honors an agency_admin's entered client account (see
  // resolveActiveOrg); falls back to the caller's home org otherwise.
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return null

  // Fetch pipeline stages
  const { data: stages } = await supabase
    .from('pipeline_stages')
    .select('*')
    .eq('organization_id', orgId)
    .order('position', { ascending: true })

  // Fetch leads with stage info
  const { data: leads } = await supabase
    .from('leads')
    .select('*')
    .eq('organization_id', orgId)
    .not('status', 'in', '("disqualified","lost")')
    .order('ai_score', { ascending: false })

  // Per-lead close probability + suggested stage moves (pure, in-process).
  // PII is encrypted at rest — decrypt server-side before rendering.
  const allLeads = decryptLeadsPII(leads || [])
  const allStages = stages || []
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
        probabilityByLead={probabilityByLead}
        suggestionByLead={suggestionByLead}
      />
    </div>
  )
}
