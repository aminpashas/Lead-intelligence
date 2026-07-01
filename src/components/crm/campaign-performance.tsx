'use client'

import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  MessageSquare, Mail, ArrowLeft, Zap,
  Users, TrendingUp, Reply, DollarSign, BarChart3,
  Target, ArrowUpRight, ArrowDownRight,
  ListFilter,
} from 'lucide-react'
import type { Campaign } from '@/types/database'

interface CampaignPerformanceProps {
  campaigns: (Campaign & {
    smart_list_name?: string
    smart_list_color?: string
  })[]
  onBack?: () => void
}

type KPI = {
  label: string
  value: string | number
  icon: React.ElementType
}

const STATUS_META: Record<string, { dot: string; text: string; label: string }> = {
  active: { dot: 'bg-aurea-primary', text: 'text-aurea-primary', label: 'Active' },
  paused: { dot: 'bg-aurea-amber', text: 'text-aurea-amber', label: 'Paused' },
  draft: { dot: 'bg-aurea-ink-3', text: 'text-aurea-ink-3', label: 'Draft' },
  completed: { dot: 'bg-aurea-gold', text: 'text-aurea-gold', label: 'Completed' },
}

function channelLabel(channel: string) {
  if (channel === 'sms') return { Icon: MessageSquare, label: 'SMS' }
  if (channel === 'email') return { Icon: Mail, label: 'Email' }
  return { Icon: Zap, label: 'Multi' }
}

export function CampaignPerformance({ campaigns, onBack }: CampaignPerformanceProps) {
  // Aggregate KPIs across all campaigns
  const totals = campaigns.reduce(
    (acc, c) => ({
      enrolled: acc.enrolled + (c.total_enrolled || 0),
      completed: acc.completed + (c.total_completed || 0),
      converted: acc.converted + (c.total_converted || 0),
      replied: acc.replied + ((c as any).total_replied || 0),
      opened: acc.opened + ((c as any).total_opened || 0),
      unsubscribed: acc.unsubscribed + (c.total_unsubscribed || 0),
      revenue: acc.revenue + ((c as any).revenue_attributed || 0),
    }),
    { enrolled: 0, completed: 0, converted: 0, replied: 0, opened: 0, unsubscribed: 0, revenue: 0 }
  )

  const overallReplyRate = totals.enrolled > 0
    ? ((totals.replied / totals.enrolled) * 100).toFixed(1)
    : '0.0'
  const overallConversionRate = totals.enrolled > 0
    ? ((totals.converted / totals.enrolled) * 100).toFixed(1)
    : '0.0'

  const kpis: KPI[] = [
    { label: 'Total Enrolled', value: totals.enrolled.toLocaleString(), icon: Users },
    { label: 'Messages Replied', value: totals.replied.toLocaleString(), icon: Reply },
    { label: 'Reply Rate', value: `${overallReplyRate}%`, icon: TrendingUp },
    { label: 'Conversions', value: totals.converted.toLocaleString(), icon: Target },
    { label: 'Conversion Rate', value: `${overallConversionRate}%`, icon: BarChart3 },
    { label: 'Revenue', value: `$${totals.revenue.toLocaleString()}`, icon: DollarSign },
  ]

  // Sort campaigns by conversion rate (best performing first)
  const ranked = [...campaigns].sort((a, b) => {
    const aRate = a.total_enrolled > 0 ? (a.total_converted / a.total_enrolled) : 0
    const bRate = b.total_enrolled > 0 ? (b.total_converted / b.total_enrolled) : 0
    return bRate - aRate
  })

  // Smart List performance
  const smartListPerformance = campaigns
    .filter((c) => (c as any).smart_list_name)
    .reduce((acc, c) => {
      const name = (c as any).smart_list_name
      if (!acc[name]) {
        acc[name] = {
          name,
          color: (c as any).smart_list_color || '#6366F1',
          campaigns: 0,
          enrolled: 0,
          converted: 0,
          replied: 0,
          revenue: 0,
        }
      }
      acc[name].campaigns++
      acc[name].enrolled += c.total_enrolled || 0
      acc[name].converted += c.total_converted || 0
      acc[name].replied += (c as any).total_replied || 0
      acc[name].revenue += (c as any).revenue_attributed || 0
      return acc
    }, {} as Record<string, any>)

  return (
    <div className="animate-in fade-in-0 duration-500">
      {/* ── Header ─────────────────────────────────────────── */}
      <header className="flex items-end justify-between gap-4 border-b border-aurea-border pb-8">
        <div>
          {onBack && (
            <button
              onClick={onBack}
              className="mb-4 inline-flex items-center gap-1.5 text-[12px] font-medium text-aurea-ink-3 transition-colors hover:text-aurea-ink"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Back to campaigns
            </button>
          )}
          <p className="aurea-eyebrow mb-3">Analytics</p>
          <h1 className="aurea-display text-[40px] text-aurea-ink sm:text-[48px]">
            Campaign Performance
          </h1>
          <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-aurea-ink-2">
            What&apos;s working and what isn&apos;t, across every campaign.
          </p>
        </div>
      </header>

      {/* ── KPI grid ───────────────────────────────────────── */}
      <div className="mt-10 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        {kpis.map((kpi) => (
          <div key={kpi.label} className="aurea-card p-5">
            <div className="flex items-center justify-between">
              <p className="aurea-eyebrow">{kpi.label}</p>
              <kpi.icon className="h-[15px] w-[15px] text-aurea-ink-3" strokeWidth={1.75} />
            </div>
            <p className="mt-4 aurea-display text-[28px] tabular-nums text-aurea-ink">{kpi.value}</p>
          </div>
        ))}
      </div>

      {/* ── Campaign rankings ──────────────────────────────── */}
      <section className="aurea-card mt-5 overflow-hidden">
        <div className="border-b border-aurea-border px-5 py-4">
          <h2 className="aurea-display text-[22px] text-aurea-ink">Campaign rankings</h2>
          <p className="mt-0.5 text-[12px] text-aurea-ink-3">Ordered by conversion rate</p>
        </div>
        {ranked.length === 0 ? (
          <p className="py-12 text-center text-[13px] text-aurea-ink-3">No campaigns to analyze yet</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="border-aurea-border hover:bg-transparent">
                {['#', 'Campaign', 'Smart List', 'Status', 'Enrolled', 'Replied', 'Reply %', 'Converted', 'Conv. %', 'Revenue'].map((h, i) => (
                  <TableHead
                    key={h}
                    className={`text-[10.5px] font-semibold uppercase tracking-[0.12em] text-aurea-ink-3 ${i >= 4 ? 'text-right' : ''} ${i === 0 ? 'w-10' : ''}`}
                  >
                    {h}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {ranked.map((campaign, index) => {
                const replyRate = campaign.total_enrolled > 0
                  ? (((campaign as any).total_replied || 0) / campaign.total_enrolled * 100)
                  : 0
                const convRate = campaign.total_enrolled > 0
                  ? (campaign.total_converted / campaign.total_enrolled * 100)
                  : 0
                const { Icon, label } = channelLabel(campaign.channel)
                const status = STATUS_META[campaign.status] ?? STATUS_META.draft
                return (
                  <TableRow key={campaign.id} className="border-aurea-border hover:bg-aurea-surface-2">
                    <TableCell>
                      <span className={`font-mono text-[13px] tabular-nums ${index === 0 ? 'text-aurea-gold' : 'text-aurea-ink-3'}`}>
                        {index + 1}
                      </span>
                    </TableCell>
                    <TableCell>
                      <p className="text-[13.5px] font-medium text-aurea-ink">{campaign.name}</p>
                      <span className="mt-0.5 inline-flex items-center gap-1.5 aurea-eyebrow">
                        <Icon className="h-3 w-3 text-aurea-ink-3" strokeWidth={1.75} />
                        {label} · {campaign.type}
                      </span>
                    </TableCell>
                    <TableCell>
                      {(campaign as any).smart_list_name ? (
                        <span className="inline-flex items-center gap-1.5 text-[12px] text-aurea-ink-2">
                          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: (campaign as any).smart_list_color }} />
                          {(campaign as any).smart_list_name}
                        </span>
                      ) : (
                        <span className="text-[12px] text-aurea-ink-3">Manual</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5">
                        <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
                        <span className={`text-[11px] font-medium ${status.text}`}>{status.label}</span>
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-[13px] tabular-nums text-aurea-ink">{campaign.total_enrolled}</TableCell>
                    <TableCell className="text-right font-mono text-[13px] tabular-nums text-aurea-ink-2">{(campaign as any).total_replied || 0}</TableCell>
                    <TableCell className={`text-right font-mono text-[13px] tabular-nums ${replyRate > 15 ? 'text-aurea-primary' : 'text-aurea-ink-2'}`}>{replyRate.toFixed(1)}%</TableCell>
                    <TableCell className="text-right font-mono text-[13px] tabular-nums text-aurea-ink">{campaign.total_converted}</TableCell>
                    <TableCell className={`text-right font-mono text-[13px] tabular-nums ${convRate > 10 ? 'text-aurea-primary' : 'text-aurea-ink-2'}`}>{convRate.toFixed(1)}%</TableCell>
                    <TableCell className="text-right font-mono text-[13px] tabular-nums text-aurea-ink">
                      ${((campaign as any).revenue_attributed || 0).toLocaleString()}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </section>

      {/* ── Smart List performance ─────────────────────────── */}
      {Object.keys(smartListPerformance).length > 0 && (
        <section className="mt-10">
          <p className="aurea-eyebrow mb-2">Segments</p>
          <h2 className="aurea-display text-[22px] text-aurea-ink">Performance by Smart List</h2>
          <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {Object.values(smartListPerformance).map((sl: any) => {
              const convRate = sl.enrolled > 0 ? ((sl.converted / sl.enrolled) * 100).toFixed(1) : '0.0'
              const replyRate = sl.enrolled > 0 ? ((sl.replied / sl.enrolled) * 100).toFixed(1) : '0.0'
              return (
                <div key={sl.name} className="aurea-card p-5">
                  <div className="flex items-center gap-2.5">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: sl.color }} />
                    <div>
                      <p className="text-[14px] font-medium text-aurea-ink">{sl.name}</p>
                      <p className="aurea-eyebrow mt-0.5">{sl.campaigns} campaign{sl.campaigns > 1 ? 's' : ''}</p>
                    </div>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-y-3">
                    {[
                      { k: 'Enrolled', v: sl.enrolled.toLocaleString() },
                      { k: 'Reply Rate', v: `${replyRate}%` },
                      { k: 'Conv. Rate', v: `${convRate}%` },
                      { k: 'Revenue', v: `$${sl.revenue.toLocaleString()}` },
                    ].map((m) => (
                      <div key={m.k}>
                        <p className="aurea-eyebrow">{m.k}</p>
                        <p className="mt-1 font-mono text-[14px] tabular-nums text-aurea-ink">{m.v}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* ── Strategy insights ──────────────────────────────── */}
      <section className="mt-10">
        <p className="aurea-eyebrow mb-2">Insights</p>
        <h2 className="aurea-display text-[22px] text-aurea-ink">Strategy</h2>
        <div className="mt-5 space-y-3">
          {campaigns.length < 2 ? (
            <div className="aurea-card p-5">
              <p className="text-[13px] text-aurea-ink-2">
                Create and run at least 2 campaigns to see comparative strategy insights.
              </p>
            </div>
          ) : (
            <>
              {ranked[0] && ranked[0].total_enrolled > 0 && (
                <div className="aurea-card flex items-start gap-3 p-4">
                  <ArrowUpRight className="mt-0.5 h-4 w-4 shrink-0 text-aurea-primary" strokeWidth={2} />
                  <div>
                    <p className="text-[13.5px] font-medium text-aurea-ink">Top performer — &quot;{ranked[0].name}&quot;</p>
                    <p className="mt-0.5 text-[12.5px] text-aurea-ink-2">
                      {ranked[0].total_enrolled} enrolled,{' '}
                      {(ranked[0].total_enrolled > 0
                        ? (ranked[0].total_converted / ranked[0].total_enrolled * 100).toFixed(1)
                        : 0)}% conversion.
                      {ranked[0].channel === 'sms' ? ' SMS campaigns tend to get faster replies.' : ''}
                    </p>
                  </div>
                </div>
              )}
              {ranked.length > 1 && ranked[ranked.length - 1]?.total_enrolled > 0 && (
                <div className="aurea-card flex items-start gap-3 p-4">
                  <ArrowDownRight className="mt-0.5 h-4 w-4 shrink-0 text-aurea-rose" strokeWidth={2} />
                  <div>
                    <p className="text-[13.5px] font-medium text-aurea-ink">Needs improvement — &quot;{ranked[ranked.length - 1].name}&quot;</p>
                    <p className="mt-0.5 text-[12.5px] text-aurea-ink-2">
                      Consider revising message copy, timing, or targeting criteria.
                    </p>
                  </div>
                </div>
              )}
              <div className="aurea-card flex items-start gap-3 p-4">
                <ListFilter className="mt-0.5 h-4 w-4 shrink-0 text-aurea-gold" strokeWidth={1.75} />
                <div>
                  <p className="text-[13.5px] font-medium text-aurea-ink">Strategy tip</p>
                  <p className="mt-0.5 text-[12.5px] text-aurea-ink-2">
                    Create Smart Lists for different lead segments (e.g. &quot;Hot + Financing Interested&quot;
                    vs &quot;Cold + No Show&quot;) and run A/B campaigns to find the best messaging for each group.
                  </p>
                </div>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  )
}
