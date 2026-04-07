import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Users, Brain, DollarSign, TrendingUp, Calendar, MessageSquare } from 'lucide-react'

export default async function AnalyticsPage() {
  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) return null

  const orgId = profile.organization_id

  // Fetch lead counts by status
  const { count: totalLeads } = await supabase
    .from('leads')
    .select('*', { count: 'exact', head: true })
    .eq('organization_id', orgId)

  const { count: hotLeads } = await supabase
    .from('leads')
    .select('*', { count: 'exact', head: true })
    .eq('organization_id', orgId)
    .eq('ai_qualification', 'hot')

  const { count: qualifiedLeads } = await supabase
    .from('leads')
    .select('*', { count: 'exact', head: true })
    .eq('organization_id', orgId)
    .in('status', ['qualified', 'consultation_scheduled', 'consultation_completed', 'treatment_presented', 'financing', 'contract_sent', 'contract_signed'])

  const { count: convertedLeads } = await supabase
    .from('leads')
    .select('*', { count: 'exact', head: true })
    .eq('organization_id', orgId)
    .in('status', ['contract_signed', 'scheduled', 'in_treatment', 'completed'])

  // Revenue pipeline
  const { data: revenueData } = await supabase
    .from('leads')
    .select('treatment_value')
    .eq('organization_id', orgId)
    .not('treatment_value', 'is', null)

  const totalPipeline = revenueData?.reduce((sum, l) => sum + (l.treatment_value || 0), 0) || 0

  // Conversation count
  const { count: activeConvos } = await supabase
    .from('conversations')
    .select('*', { count: 'exact', head: true })
    .eq('organization_id', orgId)
    .eq('status', 'active')

  const stats = [
    { name: 'Total Leads', value: totalLeads || 0, icon: Users, color: 'text-blue-600' },
    { name: 'Hot Leads', value: hotLeads || 0, icon: Brain, color: 'text-red-600' },
    { name: 'Qualified', value: qualifiedLeads || 0, icon: TrendingUp, color: 'text-green-600' },
    { name: 'Converted', value: convertedLeads || 0, icon: Calendar, color: 'text-purple-600' },
    { name: 'Pipeline Value', value: `$${(totalPipeline / 1000).toFixed(0)}k`, icon: DollarSign, color: 'text-emerald-600' },
    { name: 'Active Conversations', value: activeConvos || 0, icon: MessageSquare, color: 'text-orange-600' },
  ]

  const conversionRate = totalLeads && totalLeads > 0
    ? ((convertedLeads || 0) / totalLeads * 100).toFixed(1)
    : '0'

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Analytics</h1>
        <p className="text-muted-foreground">
          Performance overview and key metrics
        </p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
        {stats.map((stat) => (
          <Card key={stat.name}>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 mb-2">
                <stat.icon className={`h-4 w-4 ${stat.color}`} />
                <span className="text-xs text-muted-foreground">{stat.name}</span>
              </div>
              <p className="text-2xl font-bold">{stat.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Conversion Funnel */}
      <Card>
        <CardHeader>
          <CardTitle>Conversion Funnel</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {[
              { label: 'Total Leads', count: totalLeads || 0, pct: 100 },
              { label: 'Hot Leads', count: hotLeads || 0, pct: totalLeads ? ((hotLeads || 0) / totalLeads * 100) : 0 },
              { label: 'Qualified', count: qualifiedLeads || 0, pct: totalLeads ? ((qualifiedLeads || 0) / totalLeads * 100) : 0 },
              { label: 'Converted', count: convertedLeads || 0, pct: totalLeads ? ((convertedLeads || 0) / totalLeads * 100) : 0 },
            ].map((step) => (
              <div key={step.label}>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span>{step.label}</span>
                  <span className="font-medium">{step.count} ({step.pct.toFixed(1)}%)</span>
                </div>
                <div className="h-3 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${step.pct}%` }}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6 p-4 rounded-lg bg-muted/50 text-center">
            <p className="text-sm text-muted-foreground">Overall Conversion Rate</p>
            <p className="text-3xl font-bold text-primary">{conversionRate}%</p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
