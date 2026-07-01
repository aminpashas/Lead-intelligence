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
    <div className="h-full">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Pipeline</h1>
        <p className="text-muted-foreground">
          Drag leads between stages to update their status
        </p>
      </div>
      <PipelineBoard
        stages={stages || []}
        leads={leads || []}
      />
    </div>
  )
}
