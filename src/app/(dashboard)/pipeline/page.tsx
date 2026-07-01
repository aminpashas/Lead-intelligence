import { createClient } from '@/lib/supabase/server'
import { PipelineBoard } from '@/components/crm/pipeline-board'
import { resolveActiveOrg } from '@/lib/auth/active-org'

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
        stages={stages || []}
        leads={leads || []}
      />
    </div>
  )
}
