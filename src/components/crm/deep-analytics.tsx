'use client'

import { useEffect, useMemo, useState, useCallback, useSyncExternalStore, type ReactNode } from 'react'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  AlertTriangle, ArrowRight, BarChart3, Bot, CheckCircle2, Clock, Copy,
  Download, Flame, Loader2, Megaphone, MessageSquare, PhoneOff, Radar,
  Target, TrendingUp, Users, Wrench, Zap,
} from 'lucide-react'
import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, Pie,
  PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { AnalyticsDashboard } from '@/components/crm/analytics-charts'
import { ActionQueueCohortSheet } from '@/components/crm/action-queue-cohort-sheet'
import { labelChannel } from '@/lib/analytics/recommendations'
import type {
  ActionQueueCohortKey, DeepAnalytics, HeatmapCell, Recommendation, RecommendationSeverity,
} from '@/lib/analytics/deep-types'

const emptySubscribe = () => () => {}

/** Defers ResponsiveContainer until after mount (avoids SSR width warnings). */
function ChartWrapper({ height, children }: { height: string; children: ReactNode }) {
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false)
  if (!mounted) return <div className={height} />
  return (
    <div className={height}>
      <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
    </div>
  )
}

const COLORS = ['var(--chart-1)', 'var(--chart-3)', 'var(--chart-2)', 'var(--chart-5)', 'var(--chart-4)']

const TIER_META: Record<string, { label: string; color: string; hint: string }> = {
  converted: { label: 'Converted', color: 'var(--chart-1)', hint: 'Signed / revenue recorded' },
  consult: { label: 'Consult', color: 'var(--chart-2)', hint: 'Consultation scheduled or completed' },
  engaged: { label: 'Engaged', color: 'var(--chart-3)', hint: 'Replied with buying intent or 2+ replies' },
  responded: { label: 'Responded', color: 'var(--chart-4)', hint: 'Replied at least once' },
  contacted: { label: 'Contacted', color: 'var(--chart-5)', hint: 'Outbound sent, no reply yet' },
  untouched: { label: 'Untouched', color: 'var(--aurea-border)', hint: 'No outbound ever sent' },
  disqualified: { label: 'Disqualified', color: 'var(--aurea-ink-3)', hint: 'Worked and rejected' },
}

const SEVERITY_META: Record<RecommendationSeverity, { label: string; badge: string; icon: typeof Flame }> = {
  critical: { label: 'Critical', badge: 'bg-red-500/15 text-red-600 dark:text-red-400', icon: Flame },
  high: { label: 'High', badge: 'bg-orange-500/15 text-orange-600 dark:text-orange-400', icon: AlertTriangle },
  medium: { label: 'Medium', badge: 'bg-amber-500/15 text-amber-600 dark:text-amber-400', icon: Radar },
  info: { label: 'Info', badge: 'bg-sky-500/15 text-sky-600 dark:text-sky-400', icon: Target },
}

const CATEGORY_ICON: Record<Recommendation['category'], typeof Zap> = {
  budget: TrendingUp,
  creative: Megaphone,
  speed: Zap,
  process: Wrench,
  tracking: Radar,
  data: BarChart3,
}

function formatCurrency(n: number | null | undefined) {
  if (n == null) return '—'
  if (n >= 1000) return `$${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k`
  return `$${Math.round(n).toLocaleString()}`
}

function fmtPct(num: number, den: number) {
  if (!den) return '—'
  return `${((num / den) * 100).toFixed(1)}%`
}

const RANGE_OPTIONS = [
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
]

export function DeepAnalyticsPage() {
  const [data, setData] = useState<DeepAnalytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [rangeDays, setRangeDays] = useState(30)
  const [tab, setTab] = useState('actions')

  const load = useCallback(async (days: number) => {
    setLoading(true)
    setError(null)
    try {
      const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
      const res = await fetch(`/api/analytics/deep?start_date=${encodeURIComponent(start)}`)
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error || `Request failed (${res.status})`)
      }
      setData(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load deep analytics')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(rangeDays) }, [load, rangeDays])

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Analytics</h1>
          <p className="text-sm text-muted-foreground">
            Lead behavior, quality, and campaign performance — with the actions they imply
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-lg border p-1">
          {RANGE_OPTIONS.map((r) => (
            <Button
              key={r.days}
              size="sm"
              variant={rangeDays === r.days ? 'default' : 'ghost'}
              onClick={() => setRangeDays(r.days)}
            >
              {r.label}
            </Button>
          ))}
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => v && setTab(String(v))}>
        <TabsList className="flex w-full flex-wrap md:w-fit">
          <TabsTrigger value="actions">Action Center</TabsTrigger>
          <TabsTrigger value="quality">Lead Quality</TabsTrigger>
          <TabsTrigger value="engagement">Engagement</TabsTrigger>
          <TabsTrigger value="campaigns">Campaigns &amp; Sources</TabsTrigger>
          <TabsTrigger value="overview">Overview</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-2">
          <AnalyticsDashboard />
        </TabsContent>

        {loading && tab !== 'overview' ? (
          <div className="mt-4 space-y-4">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : error && tab !== 'overview' ? (
          <Card className="mt-4">
            <CardContent className="flex flex-col items-center gap-3 py-10">
              <AlertTriangle className="h-6 w-6 text-amber-500" />
              <p className="text-sm text-muted-foreground">{error}</p>
              <Button size="sm" variant="outline" onClick={() => load(rangeDays)}>Retry</Button>
            </CardContent>
          </Card>
        ) : data ? (
          <>
            <TabsContent value="actions" className="mt-2">
              <ActionCenter data={data} />
            </TabsContent>
            <TabsContent value="quality" className="mt-2">
              <LeadQualityTab data={data} />
            </TabsContent>
            <TabsContent value="engagement" className="mt-2">
              <EngagementTab data={data} />
            </TabsContent>
            <TabsContent value="campaigns" className="mt-2">
              <CampaignsTab data={data} />
            </TabsContent>
          </>
        ) : null}
      </Tabs>
    </div>
  )
}

/* ───────────────────────────── Action Center ───────────────────────────── */

function ActionCenter({ data }: { data: DeepAnalytics }) {
  const { recommendations, actionQueue } = data
  const crmRecs = recommendations.filter((r) => !r.dgsRelevant)
  const dgsRecs = recommendations.filter((r) => r.dgsRelevant)
  // Which cohort's drill-down sheet is open (null = closed).
  const [openCohort, setOpenCohort] = useState<ActionQueueCohortKey | null>(null)

  return (
    <div className="space-y-4">
      {/* Work queues — each tile opens its lead list + batch actions */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <QueueTile
          icon={Flame}
          label="Ready-to-book, untouched 48h+"
          value={actionQueue.ready_to_book_stale}
          tone={actionQueue.ready_to_book_stale > 0 ? 'critical' : 'ok'}
          onOpen={() => setOpenCohort('ready_to_book_stale')}
        />
        <QueueTile
          icon={MessageSquare}
          label="Inbound awaiting your reply"
          value={actionQueue.inbound_awaiting_reply}
          tone={actionQueue.inbound_awaiting_reply > 0 ? 'critical' : 'ok'}
          onOpen={() => setOpenCohort('inbound_awaiting_reply')}
        />
        <QueueTile
          icon={PhoneOff}
          label="New leads never contacted"
          value={actionQueue.untouched_new}
          tone={actionQueue.untouched_new > 100 ? 'warn' : 'ok'}
          onOpen={() => setOpenCohort('untouched_new')}
        />
        <QueueTile
          icon={Clock}
          label="Engaged leads gone quiet 7d+"
          value={actionQueue.engaged_gone_quiet}
          tone={actionQueue.engaged_gone_quiet > 20 ? 'warn' : 'ok'}
          onOpen={() => setOpenCohort('engaged_gone_quiet')}
        />
      </div>

      {actionQueue.samples.ready_to_book_stale.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Flame className="h-4 w-4 text-red-500" /> Call these first — they asked to book
            </CardTitle>
            <CardDescription>AI conversation analysis flagged them ready_to_book; no touch in 48h+</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-2">
            {actionQueue.samples.ready_to_book_stale.map((l) => (
              <Link key={l.id} href={`/leads/${l.id}`}>
                <Badge variant="outline" className="cursor-pointer hover:bg-accent">
                  {l.name} <ArrowRight className="ml-1 h-3 w-3" />
                </Badge>
              </Link>
            ))}
            {actionQueue.ready_to_book_stale > actionQueue.samples.ready_to_book_stale.length && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={() => setOpenCohort('ready_to_book_stale')}
              >
                View all {actionQueue.ready_to_book_stale.toLocaleString()}
                <ArrowRight className="ml-1 h-3 w-3" />
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Recommendations */}
      <div className="grid gap-4 lg:grid-cols-2">
        <RecommendationList
          title="Fix inside the CRM"
          description="Follow-up, cadence, and process actions for the practice team"
          recs={crmRecs}
          onOpenCohort={setOpenCohort}
        />
        <RecommendationList
          title="Feed back into Dion Growth Studio"
          description="Budget, creative, and tracking actions for the growth team"
          recs={dgsRecs}
          onOpenCohort={setOpenCohort}
        />
      </div>

      <DgsFeedbackPanel data={data} />

      <ActionQueueCohortSheet cohort={openCohort} onClose={() => setOpenCohort(null)} />
    </div>
  )
}

function QueueTile({ icon: Icon, label, value, tone, onOpen }: {
  icon: typeof Flame; label: string; value: number; tone: 'critical' | 'warn' | 'ok'
  onOpen: () => void
}) {
  const toneClass = tone === 'critical'
    ? 'text-red-600 dark:text-red-400'
    : tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-aurea-primary'
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      className="cursor-pointer transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`${label}: ${value.toLocaleString()} leads — open list`}
    >
      <CardContent className="pt-4">
        <div className="flex items-start justify-between">
          <div>
            <p className={`text-2xl font-bold ${toneClass}`}>{value.toLocaleString()}</p>
            <p className="mt-1 text-xs text-muted-foreground">{label}</p>
          </div>
          <Icon className={`h-4 w-4 ${toneClass}`} />
        </div>
        <p className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground">
          View leads <ArrowRight className="h-3 w-3" />
        </p>
      </CardContent>
    </Card>
  )
}

function RecommendationList({ title, description, recs, onOpenCohort }: {
  title: string; description: string; recs: Recommendation[]
  onOpenCohort: (cohort: ActionQueueCohortKey) => void
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {recs.length === 0 ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" /> Nothing flagged in this range
          </div>
        ) : (
          recs.map((rec) => <RecCard key={rec.id} rec={rec} onOpenCohort={onOpenCohort} />)
        )}
      </CardContent>
    </Card>
  )
}

function RecCard({ rec, onOpenCohort }: {
  rec: Recommendation
  onOpenCohort: (cohort: ActionQueueCohortKey) => void
}) {
  const sev = SEVERITY_META[rec.severity]
  const CatIcon = CATEGORY_ICON[rec.category]
  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${sev.badge}`}>
          <sev.icon className="h-3 w-3" /> {sev.label}
        </span>
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          <CatIcon className="h-3 w-3" /> {rec.category}
        </span>
      </div>
      <p className="mt-2 text-sm font-semibold leading-snug">{rec.title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{rec.evidence}</p>
      <p className="mt-2 flex items-start gap-1.5 text-xs">
        <ArrowRight className="mt-0.5 h-3 w-3 shrink-0 text-aurea-primary" />
        <span>{rec.action}</span>
      </p>
      {rec.cohortKey ? (
        <Button
          size="sm"
          variant="outline"
          className="mt-2 h-7 text-xs"
          onClick={() => onOpenCohort(rec.cohortKey!)}
        >
          <Users className="mr-1 h-3 w-3" /> View leads
        </Button>
      ) : rec.leadsHref ? (
        <Button
          size="sm"
          variant="outline"
          className="mt-2 h-7 text-xs"
          render={<Link href={rec.leadsHref} />}
        >
          <Users className="mr-1 h-3 w-3" /> View leads
        </Button>
      ) : null}
    </div>
  )
}

function DgsFeedbackPanel({ data }: { data: DeepAnalytics }) {
  const [copied, setCopied] = useState(false)
  const json = useMemo(() => JSON.stringify(data.dgsFeedback, null, 2), [data.dgsFeedback])

  const copy = async () => {
    await navigator.clipboard.writeText(json)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const download = () => {
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `dgs-feedback-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Bot className="h-4 w-4 text-aurea-primary" /> Dion Growth Studio feedback payload
        </CardTitle>
        <CardDescription>
          Campaign-level lead-quality rollup (join keys: attribution channel + campaign name) with the{' '}
          {data.dgsFeedback.recommendations.length} growth-side recommendations above. Feed it to DGS to
          optimize budgets and creative on real lead quality, not platform conversions.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={copy}>
          <Copy className="mr-1 h-3.5 w-3.5" /> {copied ? 'Copied!' : 'Copy JSON'}
        </Button>
        <Button size="sm" variant="outline" onClick={download}>
          <Download className="mr-1 h-3.5 w-3.5" /> Download
        </Button>
        <span className="text-xs text-muted-foreground">
          {data.dgsFeedback.channels.length} channels · {data.dgsFeedback.campaigns.length} campaigns ·{' '}
          {data.dgsFeedback.unattributed_spend.length} unattributed-spend items
        </span>
      </CardContent>
    </Card>
  )
}

/* ───────────────────────────── Lead Quality ────────────────────────────── */

function LeadQualityTab({ data }: { data: DeepAnalytics }) {
  const { qualityTiers, intentObjections, conversionLag } = data
  const tierData = qualityTiers.tiers.map((t) => ({
    ...t,
    label: TIER_META[t.tier]?.label ?? t.tier,
    fill: TIER_META[t.tier]?.color ?? 'var(--aurea-border)',
  }))
  const activeTiers = tierData.filter((t) => t.tier !== 'disqualified')
  const engagedPlus = qualityTiers.tiers
    .filter((t) => ['engaged', 'consult', 'converted'].includes(t.tier))
    .reduce((s, t) => s + t.count, 0)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile icon={Users} label="Leads in range" value={qualityTiers.total.toLocaleString()} />
        <StatTile
          icon={Target}
          label="Engaged or better"
          value={engagedPlus.toLocaleString()}
          sub={fmtPct(engagedPlus, qualityTiers.total)}
        />
        <StatTile
          icon={Clock}
          label="Median days → consult"
          value={conversionLag.to_consult_days_median != null ? `${conversionLag.to_consult_days_median}d` : '—'}
          sub={`${conversionLag.to_consult_count.toLocaleString()} consults`}
        />
        <StatTile
          icon={TrendingUp}
          label="Median days → converted"
          value={conversionLag.to_converted_days_median != null ? `${conversionLag.to_converted_days_median}d` : '—'}
          sub={`${conversionLag.to_converted_count} conversions`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Behavioral quality ladder</CardTitle>
            <CardDescription>
              Derived from what leads actually did (replies, intent, consults) — not unpopulated AI scores
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ChartWrapper height="h-72">
              <BarChart data={tierData} layout="vertical" margin={{ left: 16 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="label" width={90} tick={{ fontSize: 11 }} />
                <Tooltip
                  formatter={(v, _n, entry) => [
                    `${Number(v ?? 0).toLocaleString()} leads — ${TIER_META[(entry?.payload as { tier?: string })?.tier ?? '']?.hint ?? ''}`,
                    'Count',
                  ]}
                />
                <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                  {tierData.map((t) => <Cell key={t.tier} fill={t.fill} />)}
                </Bar>
              </BarChart>
            </ChartWrapper>
            <div className="mt-2 grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2">
              {activeTiers.slice(0, 6).map((t) => (
                <span key={t.tier}>
                  <span className="font-medium text-foreground">{t.label}:</span> {TIER_META[t.tier]?.hint}
                </span>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Conversation intent</CardTitle>
            <CardDescription>
              {intentObjections.analyzed.toLocaleString()} conversations AI-analyzed · {intentObjections.red_flags} red flags
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ChartWrapper height="h-64">
              <PieChart>
                <Pie
                  data={intentObjections.intent}
                  dataKey="n"
                  nameKey="intent"
                  innerRadius={50}
                  outerRadius={85}
                  paddingAngle={2}
                >
                  {intentObjections.intent.map((entry, i) => (
                    <Cell key={entry.intent} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v) => Number(v ?? 0).toLocaleString()} />
                <Legend formatter={(v) => String(v).replace(/_/g, " ")} />
              </PieChart>
            </ChartWrapper>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Objections raised in conversations</CardTitle>
            <CardDescription>What stops engaged leads from moving — ammunition for offers and creative</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartWrapper height="h-64">
              <BarChart data={intentObjections.objections}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="objection" tick={{ fontSize: 11 }} tickFormatter={(v: string) => v.replace(/_/g, ' ')} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v) => Number(v ?? 0).toLocaleString()} />
                <Bar dataKey="n" fill="var(--chart-3)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ChartWrapper>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Conversation sentiment</CardTitle>
            <CardDescription>Tone of analyzed threads</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartWrapper height="h-64">
              <PieChart>
                <Pie
                  data={intentObjections.sentiment}
                  dataKey="n"
                  nameKey="sentiment"
                  innerRadius={50}
                  outerRadius={85}
                  paddingAngle={2}
                >
                  {intentObjections.sentiment.map((entry, i) => (
                    <Cell key={entry.sentiment} fill={COLORS[(i + 2) % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v) => Number(v ?? 0).toLocaleString()} />
                <Legend />
              </PieChart>
            </ChartWrapper>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function StatTile({ icon: Icon, label, value, sub }: {
  icon: typeof Users; label: string; value: string; sub?: string
}) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-2xl font-bold">{value}</p>
            <p className="mt-1 text-xs text-muted-foreground">{label}</p>
            {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
          </div>
          <Icon className="h-4 w-4 text-aurea-primary" />
        </div>
      </CardContent>
    </Card>
  )
}

/* ───────────────────────────── Engagement ──────────────────────────────── */

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function EngagementTab({ data }: { data: DeepAnalytics }) {
  const { speedToLead, engagementFunnel, contactHeatmap } = data
  const [heatSource, setHeatSource] = useState<'inbound_messages' | 'lead_created'>('inbound_messages')

  const ai = engagementFunnel.ai_vs_human
  const aiRate = ai.ai_sent > 0 ? (ai.ai_replied / ai.ai_sent) * 100 : 0
  const humanRate = ai.human_sent > 0 ? (ai.human_replied / ai.human_sent) * 100 : 0

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          icon={Zap}
          label="First touch ≤5 min"
          value={`${speedToLead.pct_within_5min.toFixed(1)}%`}
          sub="of all leads in range"
        />
        <StatTile
          icon={Clock}
          label="Median first-touch latency"
          value={speedToLead.median_minutes != null
            ? speedToLead.median_minutes < 60
              ? `${Math.round(speedToLead.median_minutes)}m`
              : speedToLead.median_minutes < 1440
                ? `${(speedToLead.median_minutes / 60).toFixed(1)}h`
                : `${(speedToLead.median_minutes / 1440).toFixed(1)}d`
            : '—'}
          sub="tracked outbound after capture"
        />
        <StatTile
          icon={PhoneOff}
          label="No tracked outbound"
          value={speedToLead.never_contacted.toLocaleString()}
          sub="since lead capture"
        />
        <StatTile
          icon={Bot}
          label="AI vs human reply rate"
          value={`${aiRate.toFixed(0)}% vs ${humanRate.toFixed(0)}%`}
          sub={`${ai.ai_sent.toLocaleString()} AI · ${ai.human_sent.toLocaleString()} human sends`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Speed-to-lead vs outcomes</CardTitle>
            <CardDescription>First-touch latency buckets with response &amp; consult rates</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartWrapper height="h-72">
              <ComposedChart data={speedToLead.buckets}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="bucket" tick={{ fontSize: 11 }} />
                <YAxis yAxisId="left" tick={{ fontSize: 11 }} />
                <YAxis yAxisId="right" orientation="right" unit="%" tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend />
                <Bar yAxisId="left" dataKey="leads" name="Leads" fill="var(--chart-1)" radius={[4, 4, 0, 0]} />
                <Line yAxisId="right" dataKey="response_rate" name="Response %" stroke="var(--chart-5)" strokeWidth={2} dot />
                <Line yAxisId="right" dataKey="consult_rate" name="Consult %" stroke="var(--chart-3)" strokeWidth={2} dot />
              </ComposedChart>
            </ChartWrapper>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Touches before first reply</CardTitle>
            <CardDescription>How much persistence pays off (tracked threads since capture)</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartWrapper height="h-72">
              <BarChart data={engagementFunnel.touches_to_first_reply}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="touches" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="leads" name="Leads" fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ChartWrapper>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Channel effectiveness</CardTitle>
            <CardDescription>Reply rates by messaging channel in range</CardDescription>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2">Channel</th>
                  <th className="py-2 text-right">Sent</th>
                  <th className="py-2 text-right">Leads reached</th>
                  <th className="py-2 text-right">Replies</th>
                  <th className="py-2 text-right">Lead reply rate</th>
                </tr>
              </thead>
              <tbody>
                {engagementFunnel.channel_effectiveness.map((c) => (
                  <tr key={c.channel} className="border-b last:border-0">
                    <td className="py-2 font-medium capitalize">{c.channel}</td>
                    <td className="py-2 text-right">{c.outbound.toLocaleString()}</td>
                    <td className="py-2 text-right">{c.leads_contacted.toLocaleString()}</td>
                    <td className="py-2 text-right">{c.inbound.toLocaleString()}</td>
                    <td className={`py-2 text-right font-medium ${c.lead_reply_rate === 0 && c.outbound > 100 ? 'text-red-500' : ''}`}>
                      {c.lead_reply_rate}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base">When leads are active</CardTitle>
                <CardDescription>Practice timezone · darker = more activity</CardDescription>
              </div>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant={heatSource === 'inbound_messages' ? 'default' : 'outline'}
                  onClick={() => setHeatSource('inbound_messages')}
                >
                  Replies
                </Button>
                <Button
                  size="sm"
                  variant={heatSource === 'lead_created' ? 'default' : 'outline'}
                  onClick={() => setHeatSource('lead_created')}
                >
                  New leads
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <Heatmap cells={contactHeatmap[heatSource]} />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function Heatmap({ cells }: { cells: HeatmapCell[] }) {
  const grid = useMemo(() => {
    const m = new Map<string, number>()
    let max = 0
    for (const c of cells) {
      m.set(`${c.dow}:${c.hour}`, c.count)
      if (c.count > max) max = c.count
    }
    return { m, max }
  }, [cells])

  if (cells.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No activity in range</p>
  }

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[560px]">
        <div className="grid" style={{ gridTemplateColumns: '36px repeat(24, 1fr)', gap: 2 }}>
          <div />
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="text-center text-[9px] text-muted-foreground">
              {h % 3 === 0 ? h : ''}
            </div>
          ))}
          {DOW.map((day, dow) => (
            <DayRow key={day} day={day} dow={dow} grid={grid} />
          ))}
        </div>
      </div>
    </div>
  )
}

function DayRow({ day, dow, grid }: { day: string; dow: number; grid: { m: Map<string, number>; max: number } }) {
  return (
    <>
      <div className="pr-1 text-right text-[10px] leading-4 text-muted-foreground">{day}</div>
      {Array.from({ length: 24 }, (_, h) => {
        const count = grid.m.get(`${dow}:${h}`) ?? 0
        const intensity = grid.max > 0 ? count / grid.max : 0
        return (
          <div
            key={h}
            title={`${day} ${h}:00 — ${count}`}
            className="h-4 rounded-[2px]"
            style={{
              backgroundColor: intensity > 0
                ? `color-mix(in oklab, var(--aurea-primary) ${Math.round(15 + intensity * 85)}%, transparent)`
                : 'var(--aurea-border)',
              opacity: intensity > 0 ? 1 : 0.35,
            }}
          />
        )
      })}
    </>
  )
}

/* ─────────────────────────── Campaigns & Sources ───────────────────────── */

function CampaignsTab({ data }: { data: DeepAnalytics }) {
  const { channelScorecard, campaignScorecard, unattributedSpend, trackingCoverage } = data
  const [showAllCampaigns, setShowAllCampaigns] = useState(false)
  const campaigns = showAllCampaigns ? campaignScorecard : campaignScorecard.slice(0, 15)

  return (
    <div className="space-y-4">
      {/* Tracking coverage */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          icon={Radar}
          label="Leads with attribution channel"
          value={fmtPct(trackingCoverage.with_channel, trackingCoverage.total)}
          sub={`${trackingCoverage.with_channel.toLocaleString()} of ${trackingCoverage.total.toLocaleString()}`}
        />
        <StatTile
          icon={Target}
          label="Paid leads with campaign name"
          value={fmtPct(trackingCoverage.paid_with_campaign_name, trackingCoverage.paid_leads)}
          sub={`${trackingCoverage.paid_with_campaign_name} of ${trackingCoverage.paid_leads} paid`}
        />
        <StatTile
          icon={BarChart3}
          label="Google leads with gclid"
          value={trackingCoverage.google_with_gclid.toLocaleString()}
          sub={`Meta with fbclid: ${trackingCoverage.meta_with_fbclid}`}
        />
        <StatTile
          icon={Users}
          label="“Direct” share"
          value={`${trackingCoverage.direct_share}%`}
          sub="usually hides untracked traffic"
        />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Channel scorecard</CardTitle>
          <CardDescription>
            Lead quality by attribution channel, joined with ad spend — engagement is the quality ruler, not raw lead count
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2">Channel</th>
                <th className="py-2 text-right">Leads</th>
                <th className="py-2 text-right">Responded</th>
                <th className="py-2 text-right">Engaged</th>
                <th className="py-2 text-right">Consults</th>
                <th className="py-2 text-right">Won</th>
                <th className="py-2 text-right">Ready-to-book</th>
                <th className="py-2 text-right">Revenue</th>
                <th className="py-2 text-right">Spend</th>
                <th className="py-2 text-right">CPL</th>
                <th className="py-2 text-right">$/Engaged</th>
                <th className="py-2 text-right">$/Consult</th>
              </tr>
            </thead>
            <tbody>
              {channelScorecard.map((c) => (
                <tr key={c.channel} className="border-b last:border-0">
                  <td className="py-2 font-medium">{labelChannel(c.channel)}</td>
                  <td className="py-2 text-right">{c.leads.toLocaleString()}</td>
                  <td className="py-2 text-right">{fmtPct(c.responded, c.leads)}</td>
                  <td className="py-2 text-right">{c.engaged.toLocaleString()}</td>
                  <td className="py-2 text-right">{c.consults.toLocaleString()}</td>
                  <td className="py-2 text-right">{c.converted}</td>
                  <td className="py-2 text-right">{c.ready_to_book}</td>
                  <td className="py-2 text-right">{c.revenue > 0 ? formatCurrency(c.revenue) : '—'}</td>
                  <td className="py-2 text-right">{c.spend != null ? formatCurrency(c.spend) : '—'}</td>
                  <td className="py-2 text-right">{c.cpl != null ? `$${c.cpl}` : '—'}</td>
                  <td className={`py-2 text-right font-medium ${warnCost(c.cost_per_engaged)}`}>
                    {c.cost_per_engaged != null ? formatCurrency(c.cost_per_engaged) : '—'}
                  </td>
                  <td className={`py-2 text-right ${warnCost(c.cost_per_consult)}`}>
                    {c.cost_per_consult != null ? formatCurrency(c.cost_per_consult) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Campaign scorecard</CardTitle>
          <CardDescription>
            Per-campaign lead quality (attribution campaign name / UTM), matched to spend where the names line up
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {campaignScorecard.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No campaign-attributed leads in range — fix UTM/campaign tagging to unlock this table
            </p>
          ) : (
            <>
              <table className="w-full min-w-[820px] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2">Campaign</th>
                    <th className="py-2">Channel</th>
                    <th className="py-2 text-right">Leads</th>
                    <th className="py-2 text-right">Responded</th>
                    <th className="py-2 text-right">Engaged</th>
                    <th className="py-2 text-right">Consults</th>
                    <th className="py-2 text-right">Cost/Fin. objections</th>
                    <th className="py-2 text-right">Spend</th>
                    <th className="py-2 text-right">CPL</th>
                    <th className="py-2 text-right">$/Engaged</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => (
                    <tr key={c.campaign} className="border-b last:border-0">
                      <td className="max-w-[260px] truncate py-2 font-medium" title={c.campaign}>{c.campaign}</td>
                      <td className="py-2 text-xs text-muted-foreground">{labelChannel(c.channel)}</td>
                      <td className="py-2 text-right">{c.leads.toLocaleString()}</td>
                      <td className="py-2 text-right">{fmtPct(c.responded, c.leads)}</td>
                      <td className="py-2 text-right">{c.engaged}</td>
                      <td className="py-2 text-right">{c.consults}</td>
                      <td className="py-2 text-right">{c.cost_objections + c.financing_objections || '—'}</td>
                      <td className="py-2 text-right">{c.spend != null ? formatCurrency(c.spend) : '—'}</td>
                      <td className="py-2 text-right">{c.cpl != null ? `$${c.cpl}` : '—'}</td>
                      <td className={`py-2 text-right font-medium ${warnCost(c.cost_per_engaged)}`}>
                        {c.cost_per_engaged != null ? formatCurrency(c.cost_per_engaged) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {campaignScorecard.length > 15 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-2"
                  onClick={() => setShowAllCampaigns((s) => !s)}
                >
                  {showAllCampaigns ? 'Show top 15' : `Show all ${campaignScorecard.length}`}
                </Button>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {unattributedSpend.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-amber-500" /> Spend with zero attributable leads
            </CardTitle>
            <CardDescription>
              These campaigns spent money but no lead in the CRM carries their campaign name — pause them or fix tracking
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {unattributedSpend.map((u) => (
              <div key={`${u.channel}:${u.campaign_name}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2 text-sm">
                <span className="font-medium">{u.campaign_name}</span>
                <span className="text-xs text-muted-foreground">
                  {labelChannel(u.channel === 'meta' ? 'ppc_meta' : u.channel === 'google_ads' ? 'ppc_google' : u.channel)} ·{' '}
                  {formatCurrency(u.spend)} · {u.clicks} clicks · {u.platform_conversions} platform conversions
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function warnCost(v: number | null): string {
  if (v == null) return ''
  if (v >= 500) return 'text-red-500'
  if (v >= 150) return 'text-amber-500'
  return 'text-emerald-600 dark:text-emerald-400'
}

export function DeepAnalyticsLoading() {
  return (
    <div className="flex items-center justify-center py-20">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  )
}
