'use client'

import { useEffect, useState, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import {
  BarChart3,
  TrendingUp,
  DollarSign,
  Users,
  Target,
  Megaphone,
  Search,
  Globe,
  ArrowLeft,
  Loader2,
  Zap,
  Clock,
} from 'lucide-react'
import Link from 'next/link'

type DateRange = '30d' | '90d' | '180d' | '1y'

type AttributionRow = {
  dimension: string
  leads: number
  conversions: number
  conversionRate: number
  revenue: number
  avgDealSize: number
  hotLeads: number
  avgScore: number
  consultations: number
  noShows: number
}

type AttributionData = {
  kpis: {
    totalLeads: number
    convertedLeads: number
    conversionRate: number
    totalRevenue: number
    avgDealSize: number
    paidLeads: number
    paidConversions: number
    paidConversionRate: number
  }
  bySource: AttributionRow[]
  byUtmSource: AttributionRow[]
  byUtmMedium: AttributionRow[]
  byCampaign: AttributionRow[]
  byKeyword: AttributionRow[]
  byLandingPage: AttributionRow[]
  clickAttribution: Array<{ name: string; leads: number; conversions: number; conversionRate: number; revenue: number }>
  funnelBySource: Array<{ source: string; total: number; qualified: number; consulted: number; converted: number }>
  timeToConvert: Array<{ source: string; avgDays: number; medianDays: number; count: number }>
}

function getDateRange(range: DateRange): { start: string; end: string } {
  const end = new Date()
  let start: Date
  switch (range) {
    case '30d': start = new Date(end.getTime() - 30 * 86400000); break
    case '90d': start = new Date(end.getTime() - 90 * 86400000); break
    case '180d': start = new Date(end.getTime() - 180 * 86400000); break
    case '1y': start = new Date(end.getTime() - 365 * 86400000); break
  }
  return { start: start.toISOString().split('T')[0], end: end.toISOString().split('T')[0] }
}

function formatCurrency(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`
  return `$${n}`
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
  '(none)': 'Unattributed',
}

export default function AttributionPage() {
  const [data, setData] = useState<AttributionData | null>(null)
  const [loading, setLoading] = useState(true)
  const [dateRange, setDateRange] = useState<DateRange>('90d')
  const [activeTab, setActiveTab] = useState<'source' | 'campaign' | 'keyword' | 'landing' | 'funnel'>('source')

  const fetchData = useCallback(() => {
    setLoading(true)
    const { start, end } = getDateRange(dateRange)
    fetch(`/api/analytics/attribution?start_date=${start}&end_date=${end}`)
      .then(r => r.ok ? r.json() : null)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [dateRange])

  useEffect(() => { fetchData() }, [fetchData])

  if (loading) {
    return (
      <div className="space-y-6 animate-in fade-in-0 duration-300">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-lg" />)}
        </div>
        <Skeleton className="h-80 rounded-lg" />
      </div>
    )
  }

  if (!data) {
    return <p className="text-muted-foreground py-10 text-center">Failed to load attribution data</p>
  }

  const { kpis } = data

  return (
    <div className="space-y-6 animate-in fade-in-0 duration-500">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/analytics" className="text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <BarChart3 className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Marketing Attribution</h1>
            <p className="text-sm text-muted-foreground">End-to-end ROI tracking from ad click to revenue</p>
          </div>
        </div>
        <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
          {(['30d', '90d', '180d', '1y'] as DateRange[]).map(key => (
            <Button
              key={key}
              variant={dateRange === key ? 'default' : 'ghost'}
              size="sm"
              className="h-7 px-3 text-xs"
              onClick={() => setDateRange(key)}
            >
              {key === '30d' ? '30D' : key === '90d' ? '90D' : key === '180d' ? '6M' : '1Y'}
            </Button>
          ))}
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KPICard icon={Users} label="Total Leads" value={kpis.totalLeads} color="text-blue-600" />
        <KPICard icon={TrendingUp} label="Conversions" value={kpis.convertedLeads} color="text-green-600" subtitle={`${kpis.conversionRate}% rate`} />
        <KPICard icon={DollarSign} label="Total Revenue" value={formatCurrency(kpis.totalRevenue)} color="text-emerald-600" />
        <KPICard icon={DollarSign} label="Avg Deal Size" value={formatCurrency(kpis.avgDealSize)} color="text-purple-600" />
      </div>

      {/* Paid vs Organic */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {data.clickAttribution.map(group => (
          <Card key={group.name} className={group.revenue > 0 ? 'border-primary/20' : ''}>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 mb-2">
                {group.name.includes('Google') ? <Megaphone className="h-4 w-4 text-blue-500" /> :
                 group.name.includes('Meta') ? <Megaphone className="h-4 w-4 text-indigo-500" /> :
                 <Globe className="h-4 w-4 text-emerald-500" />}
                <span className="text-sm font-medium">{group.name}</span>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div>
                  <p className="text-lg font-bold">{group.leads}</p>
                  <p className="text-[10px] text-muted-foreground">Leads</p>
                </div>
                <div>
                  <p className="text-lg font-bold text-green-600">{group.conversions}</p>
                  <p className="text-[10px] text-muted-foreground">{group.conversionRate}% conv.</p>
                </div>
                <div>
                  <p className="text-lg font-bold text-emerald-600">{formatCurrency(group.revenue)}</p>
                  <p className="text-[10px] text-muted-foreground">Revenue</p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Tab Navigation */}
      <div className="flex items-center gap-1 bg-muted rounded-lg p-1 w-fit">
        {[
          { key: 'source', label: 'By Source', icon: Globe },
          { key: 'campaign', label: 'By Campaign', icon: Megaphone },
          { key: 'keyword', label: 'By Keyword', icon: Search },
          { key: 'landing', label: 'By Landing Page', icon: Target },
          { key: 'funnel', label: 'Funnel', icon: TrendingUp },
        ].map(tab => (
          <Button
            key={tab.key}
            variant={activeTab === tab.key ? 'default' : 'ghost'}
            size="sm"
            className="h-7 px-3 text-xs gap-1"
            onClick={() => setActiveTab(tab.key as typeof activeTab)}
          >
            <tab.icon className="h-3 w-3" />
            {tab.label}
          </Button>
        ))}
      </div>

      {/* Attribution Tables */}
      {activeTab === 'source' && (
        <AttributionTable
          title="Attribution by Lead Source"
          description="Performance breakdown by where leads originate"
          rows={data.bySource}
          labelFormatter={(d) => SOURCE_LABELS[d] || d}
        />
      )}

      {activeTab === 'campaign' && (
        <div className="space-y-6">
          <AttributionTable
            title="Attribution by Campaign"
            description="Which UTM campaigns drive the most revenue"
            rows={data.byCampaign}
          />
          <AttributionTable
            title="Attribution by UTM Source"
            description="Ad platform (google, facebook, etc.)"
            rows={data.byUtmSource}
          />
          <AttributionTable
            title="Attribution by UTM Medium"
            description="Traffic type (cpc, paid_social, email, organic)"
            rows={data.byUtmMedium}
          />
        </div>
      )}

      {activeTab === 'keyword' && (
        <AttributionTable
          title="Attribution by Keyword"
          description="Which search keywords drive the best patients (utm_term)"
          rows={data.byKeyword}
        />
      )}

      {activeTab === 'landing' && (
        <AttributionTable
          title="Attribution by Landing Page"
          description="Which pages convert visitors to leads"
          rows={data.byLandingPage}
        />
      )}

      {activeTab === 'funnel' && (
        <div className="space-y-6">
          {/* Multi-Step Funnel */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-blue-500" />
                Conversion Funnel by Source
              </CardTitle>
              <CardDescription>How leads from each source progress through the pipeline</CardDescription>
            </CardHeader>
            <CardContent>
              {data.funnelBySource.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">Not enough data yet</p>
              ) : (
                <div className="space-y-4">
                  {data.funnelBySource.map(source => {
                    const maxWidth = source.total
                    return (
                      <div key={source.source} className="space-y-1.5">
                        <div className="flex items-center justify-between text-sm">
                          <span className="font-medium">{SOURCE_LABELS[source.source] || source.source}</span>
                          <span className="text-muted-foreground text-xs">
                            {source.total} → {source.qualified} → {source.consulted} → {source.converted}
                          </span>
                        </div>
                        <div className="flex gap-1 h-5">
                          <div className="bg-blue-500 rounded-l h-full transition-all" style={{ width: `${(source.total / maxWidth) * 100}%` }} title={`Total: ${source.total}`} />
                          <div className="bg-amber-500 h-full transition-all" style={{ width: `${maxWidth > 0 ? (source.qualified / maxWidth) * 100 : 0}%` }} title={`Qualified: ${source.qualified}`} />
                          <div className="bg-purple-500 h-full transition-all" style={{ width: `${maxWidth > 0 ? (source.consulted / maxWidth) * 100 : 0}%` }} title={`Consulted: ${source.consulted}`} />
                          <div className="bg-green-500 rounded-r h-full transition-all" style={{ width: `${maxWidth > 0 ? (source.converted / maxWidth) * 100 : 0}%` }} title={`Converted: ${source.converted}`} />
                        </div>
                      </div>
                    )
                  })}
                  <div className="flex items-center gap-4 text-xs text-muted-foreground pt-2">
                    <span className="flex items-center gap-1"><span className="h-2 w-2 rounded bg-blue-500" /> Total</span>
                    <span className="flex items-center gap-1"><span className="h-2 w-2 rounded bg-amber-500" /> Qualified</span>
                    <span className="flex items-center gap-1"><span className="h-2 w-2 rounded bg-purple-500" /> Consulted</span>
                    <span className="flex items-center gap-1"><span className="h-2 w-2 rounded bg-green-500" /> Converted</span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Time-to-Convert */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Clock className="h-5 w-5 text-orange-500" />
                Time to Convert by Source
              </CardTitle>
              <CardDescription>Average days from lead capture to conversion</CardDescription>
            </CardHeader>
            <CardContent>
              {data.timeToConvert.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">Not enough conversion data yet</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left">
                        <th className="pb-2 font-medium">Source</th>
                        <th className="pb-2 font-medium text-right">Avg Days</th>
                        <th className="pb-2 font-medium text-right">Median Days</th>
                        <th className="pb-2 font-medium text-right">Conversions</th>
                        <th className="pb-2 font-medium text-right">Speed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.timeToConvert.map(row => (
                        <tr key={row.source} className="border-b last:border-0">
                          <td className="py-2 font-medium">{SOURCE_LABELS[row.source] || row.source}</td>
                          <td className="py-2 text-right tabular-nums">{row.avgDays}</td>
                          <td className="py-2 text-right tabular-nums">{row.medianDays}</td>
                          <td className="py-2 text-right tabular-nums">{row.count}</td>
                          <td className="py-2 text-right">
                            <Badge
                              variant={row.avgDays <= 7 ? 'default' : row.avgDays <= 30 ? 'secondary' : 'outline'}
                              className="text-xs"
                            >
                              {row.avgDays <= 7 ? '⚡ Fast' : row.avgDays <= 30 ? '🔄 Medium' : '🐢 Slow'}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}

function AttributionTable({
  title, description, rows, labelFormatter,
}: {
  title: string
  description: string
  rows: AttributionRow[]
  labelFormatter?: (d: string) => string
}) {
  const format = labelFormatter || ((d: string) => d)

  if (rows.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-6">No data available for this view</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="pb-2 font-medium">Source</th>
                <th className="pb-2 font-medium text-right">Leads</th>
                <th className="pb-2 font-medium text-right">Hot</th>
                <th className="pb-2 font-medium text-right">Consults</th>
                <th className="pb-2 font-medium text-right">Converted</th>
                <th className="pb-2 font-medium text-right">Conv. Rate</th>
                <th className="pb-2 font-medium text-right">Revenue</th>
                <th className="pb-2 font-medium text-right">Avg Deal</th>
                <th className="pb-2 font-medium text-right">Avg Score</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.dimension} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                  <td className="py-2.5 font-medium max-w-[200px] truncate" title={row.dimension}>
                    {format(row.dimension)}
                  </td>
                  <td className="py-2.5 text-right tabular-nums">{row.leads}</td>
                  <td className="py-2.5 text-right tabular-nums">
                    {row.hotLeads > 0 && <span className="text-red-500">{row.hotLeads}</span>}
                    {row.hotLeads === 0 && <span className="text-muted-foreground">0</span>}
                  </td>
                  <td className="py-2.5 text-right tabular-nums">{row.consultations}</td>
                  <td className="py-2.5 text-right tabular-nums font-medium text-green-600">{row.conversions}</td>
                  <td className="py-2.5 text-right">
                    <Badge
                      variant={row.conversionRate > 20 ? 'default' : row.conversionRate > 10 ? 'secondary' : 'outline'}
                      className="text-xs tabular-nums"
                    >
                      {row.conversionRate}%
                    </Badge>
                  </td>
                  <td className="py-2.5 text-right tabular-nums font-medium">{formatCurrency(row.revenue)}</td>
                  <td className="py-2.5 text-right tabular-nums text-muted-foreground">{formatCurrency(row.avgDealSize)}</td>
                  <td className="py-2.5 text-right tabular-nums">
                    {row.avgScore > 0 ? (
                      <span className={row.avgScore >= 70 ? 'text-green-600' : row.avgScore >= 40 ? 'text-amber-600' : 'text-muted-foreground'}>
                        {row.avgScore}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
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
