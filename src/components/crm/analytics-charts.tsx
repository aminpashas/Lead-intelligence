'use client'

import { useEffect, useState, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Users, Brain, DollarSign, TrendingUp, Calendar, MessageSquare,
  Flame, Thermometer, Target, Mail, Phone, Bot, Loader2,
  Clock, Zap, Timer,
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
  responseTime?: {
    avg_first_contact_minutes: number
    avg_response_minutes: number
    contacted_within_5min_pct: number
    distribution: Array<{ bucket: string; count: number }>
  }
  sourceRoi?: Array<{
    source: string; lead_count: number; conversions: number
    conversion_rate: number; total_revenue: number; avg_deal_size: number; avg_score: number
  }>
  pipelineVelocity?: Array<{ stage: string; transitions: number; avg_days_in_stage: number }>
  forecasting?: {
    hot: { count: number; probability: number; projected: number }
    warm: { count: number; probability: number; projected: number }
    cold: { count: number; probability: number; projected: number }
    total_projected: number
    avg_deal_size: number
  }
  dateRange?: { start: string; end: string }
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

type DateRange = '7d' | '30d' | '90d' | 'ytd' | '1y'

function getDateRange(range: DateRange): { start: string; end: string } {
  const end = new Date()
  let start: Date
  switch (range) {
    case '7d': start = new Date(end.getTime() - 7 * 86400000); break
    case '30d': start = new Date(end.getTime() - 30 * 86400000); break
    case '90d': start = new Date(end.getTime() - 90 * 86400000); break
    case 'ytd': start = new Date(end.getFullYear(), 0, 1); break
    case '1y': start = new Date(end.getTime() - 365 * 86400000); break
  }
  return { start: start.toISOString().split('T')[0], end: end.toISOString().split('T')[0] }
}

export function AnalyticsDashboard() {
  const [data, setData] = useState<AnalyticsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [dateRange, setDateRange] = useState<DateRange>('30d')

  const fetchData = useCallback(() => {
    setLoading(true)
    const { start, end } = getDateRange(dateRange)
    fetch(`/api/analytics?start_date=${start}&end_date=${end}`)
      .then((r) => {
        if (!r.ok) throw new Error('Failed to load analytics')
        return r.json()
      })
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [dateRange])

  useEffect(() => {
    fetchData()
  }, [fetchData])

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
      {/* Date Range Picker */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Analytics</h1>
        <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
          {([['7d', '7D'], ['30d', '30D'], ['90d', '90D'], ['ytd', 'YTD'], ['1y', '1Y']] as [DateRange, string][]).map(([key, label]) => (
            <Button
              key={key}
              variant={dateRange === key ? 'default' : 'ghost'}
              size="sm"
              className="h-7 px-3 text-xs"
              onClick={() => setDateRange(key)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>

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
            <CardTitle className="text-base">Lead Trend</CardTitle>
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

      {/* ═══ NEW: Response Time Metrics ═══ */}
      {data.responseTime && (
        <div>
          <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
            <Clock className="h-5 w-5 text-blue-500" />
            Response Time
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <KPICard
              icon={Timer}
              label="Avg First Contact"
              value={`${Math.round(data.responseTime.avg_first_contact_minutes)} min`}
              color={data.responseTime.avg_first_contact_minutes <= 5 ? 'text-green-600' : data.responseTime.avg_first_contact_minutes <= 15 ? 'text-amber-600' : 'text-red-600'}
              subtitle={data.responseTime.avg_first_contact_minutes <= 5 ? 'Excellent' : data.responseTime.avg_first_contact_minutes <= 15 ? 'Good' : 'Needs improvement'}
            />
            <KPICard
              icon={Zap}
              label="Avg Response Time"
              value={`${Math.round(data.responseTime.avg_response_minutes)} min`}
              color="text-blue-600"
            />
            <KPICard
              icon={Target}
              label="Under 5 Min"
              value={`${data.responseTime.contacted_within_5min_pct}%`}
              color={data.responseTime.contacted_within_5min_pct >= 80 ? 'text-green-600' : 'text-amber-600'}
              subtitle="of leads contacted within 5 min"
            />
          </div>
          {data.responseTime.distribution && data.responseTime.distribution.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Response Time Distribution</CardTitle>
              </CardHeader>
              <CardContent className="h-[250px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.responseTime.distribution}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="bucket" tick={{ fontSize: 12 }} />
                    <YAxis />
                    <Tooltip />
                    <Bar dataKey="count" fill="#3b82f6" radius={[4, 4, 0, 0]} name="Leads" />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ═══ NEW: Revenue Forecasting ═══ */}
      {data.forecasting && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <DollarSign className="h-5 w-5 text-emerald-500" />
              Revenue Forecast
            </CardTitle>
            <CardDescription>Projected revenue from current pipeline (weighted by probability)</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-center mb-6">
              <p className="text-4xl font-bold text-emerald-600">{formatCurrency(data.forecasting.total_projected)}</p>
              <p className="text-sm text-muted-foreground mt-1">Total Projected Revenue</p>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="text-center p-4 rounded-lg bg-red-50">
                <p className="text-sm font-medium text-red-800">Hot Leads</p>
                <p className="text-2xl font-bold text-red-600">{data.forecasting.hot.count}</p>
                <p className="text-xs text-red-600">{(data.forecasting.hot.probability * 100)}% probability</p>
                <p className="text-sm font-semibold mt-1">{formatCurrency(data.forecasting.hot.projected)}</p>
              </div>
              <div className="text-center p-4 rounded-lg bg-amber-50">
                <p className="text-sm font-medium text-amber-800">Warm Leads</p>
                <p className="text-2xl font-bold text-amber-600">{data.forecasting.warm.count}</p>
                <p className="text-xs text-amber-600">{(data.forecasting.warm.probability * 100)}% probability</p>
                <p className="text-sm font-semibold mt-1">{formatCurrency(data.forecasting.warm.projected)}</p>
              </div>
              <div className="text-center p-4 rounded-lg bg-blue-50">
                <p className="text-sm font-medium text-blue-800">Cold Leads</p>
                <p className="text-2xl font-bold text-blue-600">{data.forecasting.cold.count}</p>
                <p className="text-xs text-blue-600">{(data.forecasting.cold.probability * 100)}% probability</p>
                <p className="text-sm font-semibold mt-1">{formatCurrency(data.forecasting.cold.projected)}</p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground text-center mt-3">
              Based on avg deal size of {formatCurrency(data.forecasting.avg_deal_size)}
            </p>
          </CardContent>
        </Card>
      )}

      {/* ═══ NEW: Source ROI ═══ */}
      {data.sourceRoi && data.sourceRoi.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Lead Source ROI</CardTitle>
            <CardDescription>Revenue and conversion performance by lead source</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="pb-2 font-medium">Source</th>
                    <th className="pb-2 font-medium text-right">Leads</th>
                    <th className="pb-2 font-medium text-right">Conversions</th>
                    <th className="pb-2 font-medium text-right">Conv. Rate</th>
                    <th className="pb-2 font-medium text-right">Revenue</th>
                    <th className="pb-2 font-medium text-right">Avg Deal</th>
                    <th className="pb-2 font-medium text-right">Avg Score</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sourceRoi.map((s) => (
                    <tr key={s.source} className="border-b last:border-0">
                      <td className="py-2 font-medium">{SOURCE_LABELS[s.source] || s.source}</td>
                      <td className="py-2 text-right">{s.lead_count}</td>
                      <td className="py-2 text-right">{s.conversions}</td>
                      <td className="py-2 text-right">
                        <Badge variant={s.conversion_rate > 20 ? 'default' : 'secondary'} className="text-xs">
                          {s.conversion_rate}%
                        </Badge>
                      </td>
                      <td className="py-2 text-right font-medium">{formatCurrency(s.total_revenue)}</td>
                      <td className="py-2 text-right">{formatCurrency(s.avg_deal_size)}</td>
                      <td className="py-2 text-right">{s.avg_score}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ═══ NEW: Pipeline Velocity ═══ */}
      {data.pipelineVelocity && data.pipelineVelocity.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pipeline Velocity</CardTitle>
            <CardDescription>Average days leads spend in each pipeline stage</CardDescription>
          </CardHeader>
          <CardContent className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={data.pipelineVelocity.map((v) => ({
                  ...v,
                  stage: STATUS_LABELS[v.stage] || v.stage,
                }))}
                layout="vertical"
              >
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" tick={{ fontSize: 12 }} label={{ value: 'Days', position: 'insideBottom', offset: -5 }} />
                <YAxis dataKey="stage" type="category" tick={{ fontSize: 11 }} width={120} />
                <Tooltip formatter={(v) => [`${v} days`, 'Avg Duration']} />
                <Bar dataKey="avg_days_in_stage" fill="#8b5cf6" radius={[0, 4, 4, 0]} name="Avg Days" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}
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
