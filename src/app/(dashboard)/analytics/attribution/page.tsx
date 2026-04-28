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
  Calculator,
  AlertTriangle,
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

type Channel = 'google_ads' | 'meta' | 'ga4'

type AdSpendData = {
  range: { start: string; end: string }
  kpis: {
    spend: number
    impressions: number
    clicks: number
    conversions: number
    conversion_value: number
    sessions: number
    users: number
  }
  byChannel: Array<{
    channel: Channel
    spend: number
    impressions: number
    clicks: number
    conversions: number
    conversion_value: number
    sessions: number
    users: number
  }>
  byCampaign: Array<{
    key: string
    channel: Channel
    campaign_id: string | null
    campaign_name: string | null
    spend: number
    impressions: number
    clicks: number
    conversions: number
    conversion_value: number
    currency: string | null
  }>
  daily: Array<{
    date: string
    spend: number
    clicks: number
    impressions: number
    conversions: number
    conversion_value: number
    sessions: number
  }>
  syncStatus: Array<{
    channel: Channel
    last_synced_at: string | null
    last_success_at: string | null
    last_error: string | null
    rows_inserted_last_run: number | null
  }>
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
  const [adSpend, setAdSpend] = useState<AdSpendData | null>(null)
  const [loading, setLoading] = useState(true)
  const [dateRange, setDateRange] = useState<DateRange>('90d')
  const [activeTab, setActiveTab] = useState<'source' | 'campaign' | 'roas' | 'keyword' | 'landing' | 'funnel'>('source')

  const fetchData = useCallback(() => {
    setLoading(true)
    const { start, end } = getDateRange(dateRange)
    // Fetch attribution + ad-spend in parallel. ad-spend can fail
    // independently (no connectors configured yet) — we still want the
    // leads-side attribution to render.
    Promise.all([
      fetch(`/api/analytics/attribution?start_date=${start}&end_date=${end}`)
        .then(r => r.ok ? r.json() as Promise<AttributionData> : null)
        .catch(() => null),
      fetch(`/api/analytics/ad-spend?start_date=${start}&end_date=${end}`)
        .then(r => r.ok ? r.json() as Promise<AdSpendData> : null)
        .catch(() => null),
    ])
      .then(([attribution, spend]) => {
        setData(attribution)
        setAdSpend(spend)
      })
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
          { key: 'roas', label: 'Spend & ROAS', icon: Calculator },
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

      {activeTab === 'roas' && (
        <SpendROASView adSpend={adSpend} crmCampaigns={data.byCampaign} />
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

const CHANNEL_LABELS: Record<Channel, string> = {
  google_ads: 'Google Ads',
  meta: 'Meta',
  ga4: 'GA4',
}

function SpendROASView({
  adSpend,
  crmCampaigns,
}: {
  adSpend: AdSpendData | null
  crmCampaigns: AttributionRow[]
}) {
  if (!adSpend) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground space-y-2">
          <p className="font-medium text-foreground">Connect an ad account to see spend & ROAS</p>
          <p>
            Visit{' '}
            <Link href="/settings/connectors" className="text-primary hover:underline">
              Settings → Connectors
            </Link>{' '}
            and click <span className="font-medium">Connect with Google</span> or{' '}
            <span className="font-medium">Connect with Meta</span>.
          </p>
        </CardContent>
      </Card>
    )
  }

  // Build a fast lookup from CRM byCampaign keyed by lowercased campaign
  // name. The leads-side attribution dimension is utm_campaign — when
  // UTMs are tagged consistently with what the ad platform calls the
  // campaign, the join is clean. When they're not (Google auto-tagging,
  // typos, no UTMs at all), the row falls back to platform-reported
  // conversions and we flag the row visually so the gap is obvious.
  const crmByCampaign = new Map<string, AttributionRow>()
  for (const row of crmCampaigns) {
    if (row.dimension && row.dimension !== '(none)') {
      crmByCampaign.set(row.dimension.toLowerCase().trim(), row)
    }
  }

  // Spend from ga4 rows is always 0 (we store sessions there) — exclude
  // them from the ROAS table; they show up in their own "GA4 traffic"
  // section below.
  const paidCampaigns = adSpend.byCampaign.filter(c => c.channel !== 'ga4')

  type MergedRow = {
    key: string
    channel: Channel
    campaignName: string
    campaignId: string | null
    spend: number
    clicks: number
    impressions: number
    platformConversions: number
    platformRevenue: number
    crmLeads: number
    crmConversions: number
    crmRevenue: number
    matched: boolean
    currency: string | null
  }
  const merged: MergedRow[] = paidCampaigns.map(c => {
    const name = (c.campaign_name || '').toLowerCase().trim()
    const crm = name ? crmByCampaign.get(name) : undefined
    return {
      key: c.key,
      channel: c.channel,
      campaignName: c.campaign_name || '(unnamed)',
      campaignId: c.campaign_id,
      spend: c.spend,
      clicks: c.clicks,
      impressions: c.impressions,
      platformConversions: c.conversions,
      platformRevenue: c.conversion_value,
      crmLeads: crm?.leads ?? 0,
      crmConversions: crm?.conversions ?? 0,
      crmRevenue: crm?.revenue ?? 0,
      matched: !!crm,
      currency: c.currency,
    }
  })

  // Totals — used for the KPI cards. Spend KPIs come from ad-spend
  // (authoritative), revenue KPIs prefer CRM revenue (true closed loop)
  // with platform revenue as fallback when no UTM match.
  const totalSpend = merged.reduce((s, r) => s + r.spend, 0)
  const totalClicks = merged.reduce((s, r) => s + r.clicks, 0)
  const totalCrmConversions = merged.reduce((s, r) => s + r.crmConversions, 0)
  const totalCrmRevenue = merged.reduce((s, r) => s + r.crmRevenue, 0)
  const totalPlatformRevenue = merged.reduce((s, r) => s + r.platformRevenue, 0)
  const blendedRevenue = totalCrmRevenue > 0 ? totalCrmRevenue : totalPlatformRevenue

  const cpc = totalClicks > 0 ? totalSpend / totalClicks : 0
  const cpa = totalCrmConversions > 0 ? totalSpend / totalCrmConversions : 0
  const roas = totalSpend > 0 ? blendedRevenue / totalSpend : 0

  const sortedRows = merged.slice().sort((a, b) => b.spend - a.spend)

  return (
    <div className="space-y-6">
      {/* Spend KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KPICard
          icon={DollarSign}
          label="Total Spend"
          value={formatCurrency(totalSpend)}
          color="text-rose-600"
          subtitle={merged.length > 0 ? `${merged.length} campaign${merged.length === 1 ? '' : 's'}` : undefined}
        />
        <KPICard
          icon={Calculator}
          label="Avg CPC"
          value={cpc > 0 ? `$${cpc.toFixed(2)}` : '—'}
          color="text-blue-600"
          subtitle={`${totalClicks.toLocaleString()} clicks`}
        />
        <KPICard
          icon={Calculator}
          label="CPA (CRM)"
          value={cpa > 0 ? `$${cpa.toFixed(0)}` : '—'}
          color="text-amber-600"
          subtitle={`${totalCrmConversions} conversions`}
        />
        <KPICard
          icon={TrendingUp}
          label="Blended ROAS"
          value={roas > 0 ? `${roas.toFixed(2)}×` : '—'}
          color={roas >= 3 ? 'text-emerald-600' : roas >= 1 ? 'text-amber-600' : 'text-rose-600'}
          subtitle={totalCrmRevenue > 0 ? 'CRM revenue ÷ spend' : 'Platform revenue ÷ spend'}
        />
      </div>

      {/* Per-channel rollup */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">By Channel</CardTitle>
          <CardDescription>Spend and platform-reported metrics per ad platform</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="pb-2 font-medium">Channel</th>
                  <th className="pb-2 font-medium text-right">Impressions</th>
                  <th className="pb-2 font-medium text-right">Clicks</th>
                  <th className="pb-2 font-medium text-right">Spend</th>
                  <th className="pb-2 font-medium text-right">CPC</th>
                  <th className="pb-2 font-medium text-right">Platform Conv.</th>
                  <th className="pb-2 font-medium text-right">Platform Revenue</th>
                  <th className="pb-2 font-medium text-right">Platform ROAS</th>
                </tr>
              </thead>
              <tbody>
                {adSpend.byChannel.filter(c => c.channel !== 'ga4').map(c => {
                  const channelCpc = c.clicks > 0 ? c.spend / c.clicks : 0
                  const channelRoas = c.spend > 0 ? c.conversion_value / c.spend : 0
                  return (
                    <tr key={c.channel} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                      <td className="py-2.5 font-medium">{CHANNEL_LABELS[c.channel]}</td>
                      <td className="py-2.5 text-right tabular-nums">{c.impressions.toLocaleString()}</td>
                      <td className="py-2.5 text-right tabular-nums">{c.clicks.toLocaleString()}</td>
                      <td className="py-2.5 text-right tabular-nums font-medium">{formatCurrency(c.spend)}</td>
                      <td className="py-2.5 text-right tabular-nums text-muted-foreground">
                        {channelCpc > 0 ? `$${channelCpc.toFixed(2)}` : '—'}
                      </td>
                      <td className="py-2.5 text-right tabular-nums">{c.conversions.toFixed(1)}</td>
                      <td className="py-2.5 text-right tabular-nums">{formatCurrency(c.conversion_value)}</td>
                      <td className="py-2.5 text-right tabular-nums">
                        {channelRoas > 0 ? (
                          <span className={channelRoas >= 3 ? 'text-emerald-600 font-medium' : channelRoas >= 1 ? 'text-amber-600' : 'text-rose-600'}>
                            {channelRoas.toFixed(2)}×
                          </span>
                        ) : <span className="text-muted-foreground">—</span>}
                      </td>
                    </tr>
                  )
                })}
                {adSpend.byChannel.filter(c => c.channel !== 'ga4').length === 0 && (
                  <tr><td colSpan={8} className="py-6 text-center text-muted-foreground">No paid spend in this date range yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Per-campaign join */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">By Campaign — Spend × CRM Closed-Loop</CardTitle>
          <CardDescription>
            Joins ad-platform spend with leads & revenue from your CRM on campaign name.
            Rows flagged with a warning didn&apos;t find a matching UTM in your leads — check
            campaign tagging.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="pb-2 font-medium">Campaign</th>
                  <th className="pb-2 font-medium">Channel</th>
                  <th className="pb-2 font-medium text-right">Spend</th>
                  <th className="pb-2 font-medium text-right">Clicks</th>
                  <th className="pb-2 font-medium text-right">CPC</th>
                  <th className="pb-2 font-medium text-right">CRM Leads</th>
                  <th className="pb-2 font-medium text-right">CRM Conv.</th>
                  <th className="pb-2 font-medium text-right">CPA</th>
                  <th className="pb-2 font-medium text-right">CRM Revenue</th>
                  <th className="pb-2 font-medium text-right">ROAS</th>
                </tr>
              </thead>
              <tbody>
                {sortedRows.map(row => {
                  const rowCpc = row.clicks > 0 ? row.spend / row.clicks : 0
                  const rowCpa = row.crmConversions > 0 ? row.spend / row.crmConversions : 0
                  const rowRevenue = row.crmRevenue > 0 ? row.crmRevenue : row.platformRevenue
                  const rowRoas = row.spend > 0 ? rowRevenue / row.spend : 0
                  return (
                    <tr key={row.key} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                      <td className="py-2.5 font-medium max-w-[260px] truncate" title={row.campaignName}>
                        <div className="flex items-center gap-1.5">
                          {!row.matched && (
                            <span title="No matching utm_campaign in CRM leads — check tagging">
                              <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />
                            </span>
                          )}
                          <span className="truncate">{row.campaignName}</span>
                        </div>
                      </td>
                      <td className="py-2.5">
                        <Badge variant="outline" className="text-[10px]">
                          {CHANNEL_LABELS[row.channel]}
                        </Badge>
                      </td>
                      <td className="py-2.5 text-right tabular-nums font-medium">{formatCurrency(row.spend)}</td>
                      <td className="py-2.5 text-right tabular-nums">{row.clicks.toLocaleString()}</td>
                      <td className="py-2.5 text-right tabular-nums text-muted-foreground">
                        {rowCpc > 0 ? `$${rowCpc.toFixed(2)}` : '—'}
                      </td>
                      <td className="py-2.5 text-right tabular-nums">
                        {row.matched ? row.crmLeads : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="py-2.5 text-right tabular-nums font-medium text-green-600">
                        {row.matched ? row.crmConversions : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="py-2.5 text-right tabular-nums">
                        {rowCpa > 0 ? (
                          <span className={rowCpa <= 100 ? 'text-emerald-600' : rowCpa <= 500 ? 'text-amber-600' : 'text-rose-600'}>
                            ${rowCpa.toFixed(0)}
                          </span>
                        ) : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="py-2.5 text-right tabular-nums">{formatCurrency(rowRevenue)}</td>
                      <td className="py-2.5 text-right tabular-nums">
                        {rowRoas > 0 ? (
                          <span className={rowRoas >= 3 ? 'text-emerald-600 font-bold' : rowRoas >= 1 ? 'text-amber-600' : 'text-rose-600'}>
                            {rowRoas.toFixed(2)}×
                          </span>
                        ) : <span className="text-muted-foreground">—</span>}
                      </td>
                    </tr>
                  )
                })}
                {sortedRows.length === 0 && (
                  <tr><td colSpan={10} className="py-6 text-center text-muted-foreground">No campaign-level spend in this date range</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Sync status footnote */}
      {adSpend.syncStatus.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {adSpend.syncStatus.map(s => (
            <Badge key={s.channel} variant={s.last_error ? 'destructive' : 'outline'} className="text-[10px] gap-1">
              <Clock className="h-2.5 w-2.5" />
              {CHANNEL_LABELS[s.channel]}{' '}
              {s.last_synced_at
                ? `synced ${formatRelativeTime(s.last_synced_at)}`
                : 'never synced'}
              {s.last_error ? ' · failed' : ''}
            </Badge>
          ))}
        </div>
      )}
    </div>
  )
}

function formatRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
