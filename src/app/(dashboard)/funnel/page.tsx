import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { FunnelPlaybook } from '@/components/crm/funnel-playbook'

export default async function FunnelPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  // Get organization
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .eq('id', user.id)
    .single()

  if (!profile) redirect('/login')

  // Get pipeline stages with lead counts
  const { data: stages } = await supabase
    .from('pipeline_stages')
    .select('*')
    .eq('organization_id', profile.organization_id)
    .order('position')

  // Get lead counts per stage
  const { data: leads } = await supabase
    .from('leads')
    .select('id, stage_id, status, ai_qualification, created_at, last_contacted_at, last_responded_at, treatment_value, no_show_count')
    .eq('organization_id', profile.organization_id)

  // Get stage metrics: average time in stage, conversion rates
  const stageMetrics: Record<string, {
    count: number
    totalValue: number
    avgDaysInStage: number
    noResponseCount: number
    noShowCount: number
    hotLeads: number
  }> = {}

  const now = new Date()

  for (const stage of stages || []) {
    const stageLeads = (leads || []).filter((l) => l.stage_id === stage.id)
    const totalValue = stageLeads.reduce((sum, l) => sum + (l.treatment_value || 0), 0)
    const noResponseCount = stageLeads.filter((l) => !l.last_responded_at && l.last_contacted_at).length
    const noShowCount = stageLeads.filter((l) => l.no_show_count > 0).length
    const hotLeads = stageLeads.filter((l) => l.ai_qualification === 'hot').length

    // Calculate average days in stage (using created_at as approximation)
    let totalDays = 0
    for (const lead of stageLeads) {
      const created = new Date(lead.created_at)
      totalDays += (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24)
    }
    const avgDays = stageLeads.length > 0 ? totalDays / stageLeads.length : 0

    stageMetrics[stage.slug] = {
      count: stageLeads.length,
      totalValue,
      avgDaysInStage: Math.round(avgDays * 10) / 10,
      noResponseCount,
      noShowCount,
      hotLeads,
    }
  }

  // Total pipeline value
  const totalPipelineValue = (leads || []).reduce((sum, l) => sum + (l.treatment_value || 0), 0)
  const totalLeads = leads?.length || 0

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Funnel Playbook</h1>
        <p className="text-muted-foreground">
          Sales strategies, engagement rules, and automations for every stage of the patient journey
        </p>
      </div>

      <FunnelPlaybook
        stages={stages || []}
        stageMetrics={stageMetrics}
        totalPipelineValue={totalPipelineValue}
        totalLeads={totalLeads}
      />
    </div>
  )
}
