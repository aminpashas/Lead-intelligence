import { createClient } from '@/lib/supabase/server'
import { PipelineBoard } from '@/components/crm/pipeline-board'

export default async function PipelinePage() {
  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) return null

  // Fetch pipeline stages
  const { data: stages } = await supabase
    .from('pipeline_stages')
    .select('*')
    .eq('organization_id', profile.organization_id)
    .order('position', { ascending: true })

  // Fetch leads with stage info
  const { data: leads } = await supabase
    .from('leads')
    .select('*')
    .eq('organization_id', profile.organization_id)
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
