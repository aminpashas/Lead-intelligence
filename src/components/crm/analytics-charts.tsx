'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Users, Brain, DollarSign, TrendingUp, Calendar, MessageSquare,
  Flame, Thermometer, Target, Mail, Phone, Bot, Loader2,
} from 'lucide-react'
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'

type AnalyticsData = {
  kpis: {
    totalLeads: number
    hotLeads: number
    warmLeads: number
    qualifiedLeads: number
    convertedLeads: number
    totalPipeline: number
    totalRevenue: number
    avgScore: number
    conversionRate: number
    qualificationRate: number
  }
  leadTrend: Array<{ date: string; leads: number; conversions: number }>
  messageTrend: Array<{ date: string; outbound: number; inbound: number }>
  sourceBreakdown: Array<{ source: string; count: number }>
  qualificationDistribution: Array<{ tier: string; count: number }>
  statusDistribution: Array<{ status: string; count: number }>
  campaignPerformance: Array<{
    id: string; name: string; status: string; channel: string
    enrolled: number; completed: number; converted: number
    totalSent: number; totalDelivered: number; totalOpened: number; totalReplied: number
    deliveryRate: number; openRate: number; replyRate: number; conversionRate: number
  }>
  messaging: {
    totalOutbound: number; totalInbound: number
    aiMessages: number; aiPercentage: number
  }
  appointments: {
    scheduled: number; completed: number; noShow: number; showRate: number
  }
  financingBreakdown: Array<{ type: string; count: number }>
  budgetBreakdown: Array<{ range: string; count: number }>
}

const COLORS = ['#2563eb', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16']
const QUAL_COLORS: Record<string, string> = {
  hot: '#ef4444',
  warm: '#f59e0b',
  cold: '#3b82f6',
  unqualified: '#9ca3af',
  unscored: '#d1d5db',
}

const SOURCE_LABELS: Record<string, string> = {
  google_ads: 'Google Ads',
  meta_ads: 'Meta Ads',
  website_form: 'Website Form',
  landing_page: 'Landing Page',
  referral: 'Referral',
  walk_in: 'Walk-in',
  phone: 'Phone',
  email_campaign: 'Email',
  sms_campaign: 'SMS',
  qualify_form: 'Qualify Form',
  unknown: 'Unknown',
  other: 'Other',
}

const STATUS_LABELS: Record<string, string> = {
  new: 'New',
  contacted: 'Contacted',
  qualified: 'Qualified',
  consultation_scheduled: 'Consult Scheduled',
  consultation_completed: 'Consult Done',
  treatment_presented: 'Treatment Presented',
  financing: 'Financing',
  contract_sent: 'Contract Sent',
  contract_signed: 'Contract Signed',
  scheduled: 'Scheduled',
  in_treatment: 'In Treatment',
  completed: 'Completed',
  lost: 'Lost',
  disqualified: 'Disqualified',
  no_show: 'No-Show',
  unresponsive: 'Unresponsive',
}

const FINANCING_LABELS: Record<string, string> = {
  cash_pay: 'Cash Pay',
  financing_needed: 'Financing Needed',
  insurance_only: 'Insurance Only',
  undecided: 'Undecided',
}

function formatCurrency(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`
  return `$${n}`
}

function formatDate(dateStr: unknown) {
  const d = new Date(String(dateStr) + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function AnalyticsDashboard() {
  const [data, setData] = useState<AnalyticsData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/analytics')
      .then((r) => r.json())
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!data) {
    return <p className="text-muted-foreground py-10 text-center">Failed to load analytics</p>
  }

  const { kpis } = data

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <KPICard icon={Users} label="Total Leads" value={kpis.totalLeads} color="text-blue-600" />
        <KPICard icon={Flame} label="Hot Leads" value={kpis.hotLeads} color="text-red-500" />
        <KPICard icon={Thermometer} label="Warm Leads" value={kpis.warmLeads} color="text-amber-500" />
        <KPICard icon={Target} label="Qualified" value={kpis.qualifiedLeads} color="text-green-600" subtitle={`${kpis.qualificationRate.toFixed(1)}% rate`} />
        <KPICard icon={TrendingUp} label="Converted" value={kpis.convertedLeads} color="text-purple-600" subtitle={`${kpis.conversionRate.toFixed(1)}% rate`} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KPICard icon={DollarSign} label="Pipeline Value" value={formatCurrency(kpis.totalPipeline)} color="text-emerald-600" />
        <KPICard icon={DollarSign} label="Revenue" value={formatCurrency(kpis.totalRevenue)} color="text-green-700" />
        <KPICard icon={Brain} label="Avg AI Score" value={kpis.avgScore} color="text-indigo-600" subtitle="out of 100" />
        <KPICard icon={Calendar} label="Appointments" value={data.appointments.scheduled + data.appointments.completed} color="text-orange-600" subtitle={`${data.appointments.showRate.toFixed(0)}% show rate`} />
      </div>

      {/* Lead Trend + Message Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Lead Trend (30 Days)</CardTitle>
            <CardDescription>New leads and conversions per day</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[280px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data.leadTrend}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="date" tickFormatter={formatDate} fontSize={11} />
                  <YAxis fontSize={11} allowDecimals={false} />
                  <Tooltip
                    labelFormatter={formatDate}
                    contentStyle={{ borderRadius: '8px', fontSize: '13px' }}
                  />
                  <Legend />
                  <Area
                    type="monotone" dataKey="leads" name="New Leads"
                    stroke="#2563eb" fill="#2563eb" fillOpacity={0.15} strokeWidth={2}
                  />
                  <Area
                    type="monotone" dataKey="conversions" name="Conversions"
                    stroke="#10b981" fill="#10b981" fillOpacity={0.15} strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Message Activity (30 Days)</CardTitle>
            <CardDescription>
              Outbound vs inbound messages &middot;{' '}
              <span className="font-medium">{data.messaging.aiPercentage.toFixed(0)}% AI-generated</span>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[280px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.messageTrend}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="date" tickFormatter={formatDate} fontSize={11} />
                  <YAxis fontSize={11} allowDecimals={false} />
                  <Tooltip
                    labelFormatter={formatDate}
                    contentStyle={{ borderRadius: '8px', fontSize: '13px' }}
                  />
                  <Legend />
                  <Bar dataKey="outbound" name="Sent" fill="#2563eb" radius={[2, 2, 0, 0]} />
                  <Bar dataKey="inbound" name="Received" fill="#10b981" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Source Breakdown + AI Qualification */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Lead Sources</CardTitle>
            <CardDescription>Where your leads come from</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={data.sourceBreakdown}
                    dataKey="count"
                    nameKey="source"
                    cx="50%" cy="50%"
                    outerRadius={90}
                    innerRadius={50}
                    paddingAngle={2}
                    label={({ percent, ...rest }: any) =>
                      `${SOURCE_LABELS[rest.source] || rest.source} ${(percent * 100).toFixed(0)}%`
                    }
                    labelLine={false}
                    fontSize={11}
                  >
                    {data.sourceBreakdown.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value: any, name: any) => [value, SOURCE_LABELS[name] || name]}
                    contentStyle={{ borderRadius: '8px', fontSize: '13px' }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">AI Qualification</CardTitle>
            <CardDescription>Lead quality distribution</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={data.qualificationDistribution}
                  layout="vertical"
                >
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis type="number" fontSize={11} allowDecimals={false} />
                  <YAxis
                    type="category" dataKey="tier" fontSize={12} width={80}
                    tickFormatter={(v) => v.charAt(0).toUpperCase() + v.slice(1)}
                  />
                  <Tooltip contentStyle={{ borderRadius: '8px', fontSize: '13px' }} />
                  <Bar dataKey="count" name="Leads" radius={[0, 4, 4, 0]}>
                    {data.qualificationDistribution.map((entry) => (
                      <Cell key={entry.tier} fill={QUAL_COLORS[entry.tier] || '#9ca3af'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Financing Interest</CardTitle>
            <CardDescription>How leads plan to pay</CardDescription>
          </CardHeader>
          <CardContent>
            {data.financingBreakdown.length === 0 ? (
              <p className="text-sm text-muted-foreground py-10 text-center">No data yet</p>
            ) : (
              <div className="h-[260px]">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={data.financingBreakdown}
                      dataKey="count"
                      nameKey="type"
                      cx="50%" cy="50%"
                      outerRadius={90}
                      innerRadius={50}
                      paddingAngle={2}
                      label={({ percent, ...rest }: any) =>
                        `${FINANCING_LABELS[rest.type] || rest.type} ${(percent * 100).toFixed(0)}%`
                      }
                      labelLine={false}
                      fontSize={11}
                    >
                      {data.financingBreakdown.map((_, i) => (
                        <Cell key={i} fill={COLORS[(i + 3) % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value: any, name: any) => [value, FINANCING_LABELS[name] || name]}
                      contentStyle={{ borderRadius: '8px', fontSize: '13px' }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Conversion Funnel */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Conversion Funnel</CardTitle>
          <CardDescription>Lead progression from capture to close</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[
              { label: 'Total Leads', count: kpis.totalLeads, pct: 100 },
              { label: 'Hot + Warm', count: kpis.hotLeads + kpis.warmLeads, pct: kpis.totalLeads ? ((kpis.hotLeads + kpis.warmLeads) / kpis.totalLeads * 100) : 0 },
              { label: 'Qualified', count: kpis.qualifiedLeads, pct: kpis.totalLeads ? (kpis.qualifiedLeads / kpis.totalLeads * 100) : 0 },
              { label: 'Converted', count: kpis.convertedLeads, pct: kpis.totalLeads ? (kpis.convertedLeads / kpis.totalLeads * 100) : 0 },
            ].map((step, i) => (
              <div key={step.label}>
                <div className="flex items-center justify-between text-sm mb-1.5">
                  <span className="font-medium">{step.label}</span>
                  <div className="flex items-center gap-3">
                    <span className="text-muted-foreground">{step.pct.toFixed(1)}%</span>
                    <span className="font-semibold tabular-nums w-12 text-right">{step.count}</span>
                  </div>
                </div>
                <div className="h-4 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${Math.max(step.pct, step.count > 0 ? 2 : 0)}%`,
                      backgroundColor: ['#2563eb', '#f59e0b', '#10b981', '#8b5cf6'][i],
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Campaign Performance */}
      {data.campaignPerformance.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Campaign Performance</CardTitle>
            <CardDescription>Active and completed campaign metrics</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="pb-2 font-medium">Campaign</th>
                    <th className="pb-2 font-medium text-center">Status</th>
                    <th className="pb-2 font-medium text-right">Enrolled</th>
                    <th className="pb-2 font-medium text-right">Sent</th>
                    <th className="pb-2 font-medium text-right">Delivered</th>
                    <th className="pb-2 font-medium text-right">Replied</th>
                    <th className="pb-2 font-medium text-right">Converted</th>
                    <th className="pb-2 font-medium text-right">Conv. Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {data.campaignPerformance.map((c) => (
                    <tr key={c.id} className="border-b last:border-0">
                      <td className="py-2.5">
                        <div className="flex items-center gap-2">
                          {c.channel === 'sms' ? <Phone className="h-3.5 w-3.5 text-blue-500" /> :
                           c.channel === 'email' ? <Mail className="h-3.5 w-3.5 text-purple-500" /> :
                           <MessageSquare className="h-3.5 w-3.5 text-amber-500" />}
                          <span className="font-medium">{c.name}</span>
                        </div>
                      </td>
                      <td className="py-2.5 text-center">
                        <Badge variant={c.status === 'active' ? 'default' : 'secondary'} className="text-xs">
                          {c.status}
                        </Badge>
                      </td>
                      <td className="py-2.5 text-right tabular-nums">{c.enrolled}</td>
                      <td className="py-2.5 text-right tabular-nums">{c.totalSent}</td>
                      <td className="py-2.5 text-right tabular-nums">{c.totalDelivered}</td>
                      <td className="py-2.5 text-right tabular-nums">{c.totalReplied}</td>
                      <td className="py-2.5 text-right tabular-nums">{c.converted}</td>
                      <td className="py-2.5 text-right tabular-nums font-medium">
                        {c.conversionRate.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Lead Status Breakdown + Messaging Stats + Appointment Stats */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Lead Status</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {data.statusDistribution.map((s) => (
                <div key={s.status} className="flex items-center justify-between text-sm">
                  <span>{STATUS_LABELS[s.status] || s.status}</span>
                  <div className="flex items-center gap-2">
                    <div className="w-24 h-2 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${kpis.totalLeads > 0 ? (s.count / kpis.totalLeads * 100) : 0}%` }}
                      />
                    </div>
                    <span className="tabular-nums font-medium w-8 text-right">{s.count}</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <MessageSquare className="h-4 w-4" /> Messaging
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg bg-blue-50 p-3 text-center">
                  <p className="text-2xl font-bold text-blue-700">{data.messaging.totalOutbound}</p>
                  <p className="text-xs text-blue-600">Sent</p>
                </div>
                <div className="rounded-lg bg-green-50 p-3 text-center">
                  <p className="text-2xl font-bold text-green-700">{data.messaging.totalInbound}</p>
                  <p className="text-xs text-green-600">Received</p>
                </div>
              </div>
              <div className="rounded-lg bg-purple-50 p-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Bot className="h-4 w-4 text-purple-600" />
                  <span className="text-sm text-purple-700">AI-Generated</span>
                </div>
                <div className="text-right">
                  <span className="font-bold text-purple-700">{data.messaging.aiMessages}</span>
                  <span className="text-xs text-purple-500 ml-1">({data.messaging.aiPercentage.toFixed(0)}%)</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Calendar className="h-4 w-4" /> Appointments
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-lg bg-blue-50 p-3 text-center">
                  <p className="text-xl font-bold text-blue-700">{data.appointments.scheduled}</p>
                  <p className="text-xs text-blue-600">Upcoming</p>
                </div>
                <div className="rounded-lg bg-green-50 p-3 text-center">
                  <p className="text-xl font-bold text-green-700">{data.appointments.completed}</p>
                  <p className="text-xs text-green-600">Completed</p>
                </div>
                <div className="rounded-lg bg-red-50 p-3 text-center">
                  <p className="text-xl font-bold text-red-700">{data.appointments.noShow}</p>
                  <p className="text-xs text-red-600">No-Show</p>
                </div>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-xs text-muted-foreground mb-1">Show Rate</p>
                <p className="text-2xl font-bold">{data.appointments.showRate.toFixed(0)}%</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function KPICard({
  icon: Icon, label, value, color, subtitle,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string | number
  color: string
  subtitle?: string
}) {
  return (
    <Card>
      <CardContent className="pt-4 pb-3">
        <div className="flex items-center gap-2 mb-1.5">
          <Icon className={`h-4 w-4 ${color}`} />
          <span className="text-xs text-muted-foreground">{label}</span>
        </div>
        <p className="text-2xl font-bold">{value}</p>
        {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
      </CardContent>
    </Card>
  )
}
