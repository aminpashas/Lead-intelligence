import { createClient } from '@/lib/supabase/server'
import {
  Building2,
  Users,
  Zap,
  TrendingUp,
  Brain,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import Link from 'next/link'

export const metadata = {
  title: 'Agency Home | Lead Intelligence',
}

export default async function AgencyHomePage() {
  const supabase = await createClient()

  // Fetch all organizations (agency_admin RLS allows this)
  const { data: organizations } = await supabase
    .from('organizations')
    .select('id, name, slug, subscription_tier, subscription_status, created_at')
    .order('created_at', { ascending: false })

  // Fetch aggregate stats
  const { count: totalLeads } = await supabase
    .from('leads')
    .select('id', { count: 'exact', head: true })

  const { count: totalConversations } = await supabase
    .from('conversations')
    .select('id', { count: 'exact', head: true })

  const { data: agencySettings } = await supabase
    .from('agency_settings')
    .select('key, value')

  const aiModelSetting = agencySettings?.find((s) => s.key === 'ai_model')
  const aiPersonaSetting = agencySettings?.find((s) => s.key === 'ai_persona')
  const aiModel = aiModelSetting?.value as { model?: string } | undefined
  const aiPersona = aiPersonaSetting?.value as { name?: string } | undefined

  const practiceCount = organizations?.length ?? 0
  const activeCount = organizations?.filter((o) => o.subscription_status === 'active').length ?? 0

  const kpis = [
    {
      label: 'Active Practices',
      value: activeCount,
      total: practiceCount,
      icon: Building2,
      color: 'text-violet-400',
      bg: 'bg-violet-500/10',
    },
    {
      label: 'Total Leads',
      value: totalLeads ?? 0,
      icon: Users,
      color: 'text-blue-400',
      bg: 'bg-blue-500/10',
    },
    {
      label: 'Conversations',
      value: totalConversations ?? 0,
      icon: TrendingUp,
      color: 'text-emerald-400',
      bg: 'bg-emerald-500/10',
    },
    {
      label: 'AI Agent',
      value: aiPersona?.name ?? 'Aria',
      icon: Brain,
      color: 'text-amber-400',
      bg: 'bg-amber-500/10',
      isText: true,
    },
  ]

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Zap className="h-5 w-5 text-violet-400" />
          <h1 className="text-2xl font-bold text-white">Agency Control Panel</h1>
        </div>
        <p className="text-slate-400 text-sm">
          Manage all practices, AI configuration, and platform-wide settings.
        </p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {kpis.map((kpi) => (
          <Card
            key={kpi.label}
            className="bg-slate-900 border-slate-800 hover:border-slate-700 transition-colors"
          >
            <CardContent className="pt-5">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs text-slate-500 font-medium mb-1">{kpi.label}</p>
                  <p className={`text-2xl font-bold ${kpi.color}`}>
                    {kpi.isText
                      ? kpi.value
                      : typeof kpi.value === 'number'
                        ? kpi.value.toLocaleString()
                        : kpi.value}
                  </p>
                  {kpi.total !== undefined && (
                    <p className="text-xs text-slate-500 mt-0.5">{kpi.total} total</p>
                  )}
                </div>
                <div className={`h-9 w-9 rounded-xl ${kpi.bg} flex items-center justify-center`}>
                  <kpi.icon className={`h-4 w-4 ${kpi.color}`} />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Two-column layout: Practices + AI Config */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Practices */}
        <Card className="bg-slate-900 border-slate-800">
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <div>
              <CardTitle className="text-white text-base">Practices</CardTitle>
              <CardDescription className="text-slate-500 text-xs">
                All customer practices on the platform
              </CardDescription>
            </div>
            <Link href="/agency/practices">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white"
              >
                View All <ArrowRight className="ml-1 h-3 w-3" />
              </Button>
            </Link>
          </CardHeader>
          <CardContent className="space-y-2">
            {organizations && organizations.length > 0 ? (
              organizations.slice(0, 5).map((org) => (
                <div
                  key={org.id}
                  className="flex items-center justify-between py-2 border-b border-slate-800 last:border-0"
                >
                  <div className="flex items-center gap-2">
                    <div className="h-7 w-7 rounded-lg bg-slate-800 flex items-center justify-center">
                      <Building2 className="h-3.5 w-3.5 text-slate-400" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-slate-200">{org.name}</p>
                      <p className="text-xs text-slate-500">{org.slug}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge
                      className="capitalize text-[10px] h-4 px-1.5"
                      variant={org.subscription_status === 'active' ? 'default' : 'secondary'}
                    >
                      {org.subscription_tier}
                    </Badge>
                    {org.subscription_status === 'active' ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                    ) : (
                      <AlertCircle className="h-3.5 w-3.5 text-amber-400" />
                    )}
                  </div>
                </div>
              ))
            ) : (
              <p className="text-sm text-slate-500 py-4 text-center">
                No practices yet. Add your first practice.
              </p>
            )}
          </CardContent>
        </Card>

        {/* AI Platform Status */}
        <Card className="bg-slate-900 border-slate-800">
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <div>
              <CardTitle className="text-white text-base">AI Platform</CardTitle>
              <CardDescription className="text-slate-500 text-xs">
                Current configuration across all practices
              </CardDescription>
            </div>
            <Link href="/agency/ai-config">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white"
              >
                Configure <ArrowRight className="ml-1 h-3 w-3" />
              </Button>
            </Link>
          </CardHeader>
          <CardContent className="space-y-3">
            {[
              {
                label: 'AI Model',
                value: aiModel?.model ?? 'claude-3-5-sonnet-20241022',
                status: 'active',
              },
              {
                label: 'Agent Persona',
                value: aiPersona?.name ?? 'Aria',
                status: 'active',
              },
              {
                label: 'Anthropic API',
                value: process.env.ANTHROPIC_API_KEY ? 'Connected' : 'Not configured',
                status: process.env.ANTHROPIC_API_KEY ? 'active' : 'error',
              },
              {
                label: 'Twilio SMS',
                value: process.env.TWILIO_ACCOUNT_SID ? 'Connected' : 'Not configured',
                status: process.env.TWILIO_ACCOUNT_SID ? 'active' : 'error',
              },
              {
                label: 'Resend Email',
                value: process.env.RESEND_API_KEY ? 'Connected' : 'Not configured',
                status: process.env.RESEND_API_KEY ? 'active' : 'error',
              },
            ].map((item) => (
              <div key={item.label} className="flex items-center justify-between py-1">
                <span className="text-sm text-slate-400">{item.label}</span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-300">{item.value}</span>
                  {item.status === 'active' ? (
                    <div className="h-2 w-2 rounded-full bg-emerald-400" />
                  ) : (
                    <div className="h-2 w-2 rounded-full bg-red-400" />
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Quick Actions */}
      <div>
        <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">
          Quick Actions
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: 'Manage Practices', href: '/agency/practices', icon: Building2 },
            { label: 'AI Configuration', href: '/agency/ai-config', icon: Brain },
            { label: 'Integrations', href: '/agency/integrations', icon: Zap },
            { label: 'AI Training', href: '/agency/ai-training', icon: TrendingUp },
          ].map((action) => (
            <Link key={action.label} href={action.href}>
              <div className="group flex items-center gap-3 rounded-xl bg-slate-900 border border-slate-800 hover:border-violet-500/30 hover:bg-slate-800/60 p-4 cursor-pointer transition-all duration-200">
                <div className="h-8 w-8 rounded-lg bg-violet-500/10 flex items-center justify-center group-hover:bg-violet-500/20 transition-colors">
                  <action.icon className="h-4 w-4 text-violet-400" />
                </div>
                <span className="text-sm font-medium text-slate-300 group-hover:text-white transition-colors">
                  {action.label}
                </span>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
