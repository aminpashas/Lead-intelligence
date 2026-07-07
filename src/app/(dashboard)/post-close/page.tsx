import { createClient } from '@/lib/supabase/server'
import { PipelineBoard } from '@/components/crm/pipeline-board'
import { decryptLeadsPII } from '@/lib/encryption'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { isFocusedStaff } from '@/lib/auth/permissions'
import { redirect } from 'next/navigation'
import { POST_CLOSE_STAGE_SLUGS } from '@/lib/pipeline/stage-groups'

export default async function PostClosePage() {
  const supabase = await createClient()

  // Effective org honors an agency_admin's entered client account.
  const { orgId, role } = await resolveActiveOrg(supabase)
  if (!orgId) return null

  // Whole-book PII surface — focused (clinical) staff get the Today view.
  if (isFocusedStaff(role || 'member')) redirect('/dashboard')

  // Post-close = fulfillment stages only (Contract Signed → Scheduled → Completed),
  // ordered by their canonical position so the funnel reads left-to-right.
  const { data: stages } = await supabase
    .from('pipeline_stages')
    .select('*')
    .eq('organization_id', orgId)
    .in('slug', POST_CLOSE_STAGE_SLUGS as unknown as string[])
    .order('position', { ascending: true })

  const allStages = stages || []

  // One bounded, ai_score-ordered fetch per stage, each carrying its own exact
  // count. These are already-won cases, so we show the TRUE stage population —
  // no sales-status filter (a signed patient belongs on the fulfillment board
  // regardless of a stale lead status).
  const CARD_CAP = 80
  const perStage = await Promise.all(
    allStages.map(async (s) => {
      const { data, count } = await supabase
        .from('leads')
        .select('*', { count: 'exact' })
        .eq('organization_id', orgId)
        .eq('stage_id', s.id)
        .order('ai_score', { ascending: false })
        .range(0, CARD_CAP - 1)
      return { stageId: s.id, rows: data || [], count: count ?? 0 }
    })
  )

  const stageCounts: Record<string, number> = {}
  for (const p of perStage) stageCounts[p.stageId] = p.count
  // Grand total for the "All" chip — sum of the fulfillment stages.
  const totalLeadCount = perStage.reduce((sum, p) => sum + p.count, 0)

  const allLeads = decryptLeadsPII(perStage.flatMap((p) => p.rows))

  return (
    <div className="h-full animate-in fade-in-0 duration-500">
      <header className="mb-6 border-b border-aurea-border pb-6">
        <p className="aurea-eyebrow mb-2">Fulfillment</p>
        <h1 className="aurea-display text-[32px] text-aurea-ink sm:text-[40px]">Post-Close</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-aurea-ink-2">
          Signed cases moving to treatment. Drag between stages to track fulfillment.
        </p>
      </header>
      <PipelineBoard stages={allStages} leads={allLeads} stageCounts={stageCounts} totalLeadCount={totalLeadCount} />
    </div>
  )
}
