'use client'

import { useState, useEffect } from 'react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Send, CheckCircle, XCircle, Users, TrendingUp,
  MessageSquare, Mail, ArrowLeft, Sparkles,
} from 'lucide-react'
import { toast } from 'sonner'

type StepStat = {
  step_number: number
  name: string
  channel: string
  delay_minutes: number
  total_sent: number
  total_delivered: number
  total_opened: number
  total_replied: number
  delivery_rate: string
  open_rate: string
  reply_rate: string
  body_preview: string
  ai_personalize: boolean
}

type CampaignStats = {
  campaign: {
    id: string
    name: string
    type: string
    channel: string
    status: string
    total_enrolled: number
    total_completed: number
    total_converted: number
    total_unsubscribed: number
    created_at: string
  }
  enrollments: {
    total: number
    active: number
    completed: number
    exited: number
    paused: number
    unsubscribed: number
    exitReasons: Record<string, number>
  }
  steps: StepStat[]
  funnel: Array<{ label: string; count: number }>
}

const STATUS_META: Record<string, { dot: string; text: string; label: string }> = {
  active: { dot: 'bg-aurea-primary', text: 'text-aurea-primary', label: 'Active' },
  paused: { dot: 'bg-aurea-amber', text: 'text-aurea-amber', label: 'Paused' },
  draft: { dot: 'bg-aurea-ink-3', text: 'text-aurea-ink-3', label: 'Draft' },
  completed: { dot: 'bg-aurea-gold', text: 'text-aurea-gold', label: 'Completed' },
}

function FunnelBar({ label, count, maxCount }: { label: string; count: number; maxCount: number }) {
  const pct = maxCount > 0 ? (count / maxCount) * 100 : 0
  return (
    <div className="flex items-center gap-4">
      <span className="w-24 shrink-0 text-right text-[12px] text-aurea-ink-3">{label}</span>
      <div className="relative h-7 flex-1 overflow-hidden rounded-md bg-aurea-surface-2">
        <div
          className="h-full rounded-md bg-aurea-primary/85 transition-all"
          style={{ width: `${pct}%` }}
        />
        <span className="absolute inset-0 flex items-center px-2.5 font-mono text-[11px] tabular-nums text-aurea-ink">
          {count.toLocaleString()} · {pct.toFixed(0)}%
        </span>
      </div>
    </div>
  )
}

export function CampaignAnalytics({
  campaignId,
  onBack,
}: {
  campaignId: string
  onBack: () => void
}) {
  const [stats, setStats] = useState<CampaignStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchStats()
  }, [campaignId])

  async function fetchStats() {
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/stats`)
      if (!res.ok) throw new Error('Failed to fetch stats')
      const data = await res.json()
      setStats(data)
    } catch {
      toast.error('Failed to load campaign analytics')
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return <div className="py-16 text-center text-[13px] text-aurea-ink-3">Loading campaign analytics…</div>
  }

  if (!stats) {
    return <div className="py-16 text-center text-[13px] text-aurea-ink-3">Campaign not found</div>
  }

  const { campaign, enrollments, steps, funnel } = stats
  const maxFunnel = funnel.length > 0 ? Math.max(...funnel.map((f) => f.count), 1) : 1
  const status = STATUS_META[campaign.status] ?? STATUS_META.draft
  const ChannelIcon = campaign.channel === 'sms' ? MessageSquare : Mail

  const kpis = [
    { label: 'Enrolled', value: enrollments.total, icon: Users },
    { label: 'Active', value: enrollments.active, icon: Send },
    { label: 'Completed', value: enrollments.completed, icon: CheckCircle },
    { label: 'Exited', value: enrollments.exited, icon: XCircle },
    { label: 'Converted', value: campaign.total_converted || 0, icon: TrendingUp },
  ]

  return (
    <div className="animate-in fade-in-0 duration-500">
      {/* ── Header ─────────────────────────────────────────── */}
      <header className="border-b border-aurea-border pb-8">
        <button
          onClick={onBack}
          className="mb-4 inline-flex items-center gap-1.5 text-[12px] font-medium text-aurea-ink-3 transition-colors hover:text-aurea-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to campaigns
        </button>
        <p className="aurea-eyebrow mb-3">Campaign analytics</p>
        <h1 className="aurea-display text-[38px] text-aurea-ink sm:text-[46px]">{campaign.name}</h1>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
            <span className={`text-[12px] font-medium ${status.text}`}>{status.label}</span>
          </span>
          <span className="aurea-eyebrow inline-flex items-center gap-1.5">
            <ChannelIcon className="h-3.5 w-3.5 text-aurea-ink-3" strokeWidth={1.75} />
            {campaign.channel}
          </span>
          <span className="aurea-eyebrow">{campaign.type}</span>
        </div>
      </header>

      {/* ── KPI grid ───────────────────────────────────────── */}
      <div className="mt-10 grid grid-cols-2 gap-4 md:grid-cols-5">
        {kpis.map((kpi) => (
          <div key={kpi.label} className="aurea-card p-5">
            <div className="flex items-center justify-between">
              <p className="aurea-eyebrow">{kpi.label}</p>
              <kpi.icon className="h-[15px] w-[15px] text-aurea-ink-3" strokeWidth={1.75} />
            </div>
            <p className="mt-4 aurea-display text-[30px] tabular-nums text-aurea-ink">{kpi.value.toLocaleString()}</p>
          </div>
        ))}
      </div>

      {/* ── Conversion funnel ──────────────────────────────── */}
      <section className="aurea-card mt-5 overflow-hidden">
        <div className="border-b border-aurea-border px-5 py-4">
          <h2 className="aurea-display text-[22px] text-aurea-ink">Conversion funnel</h2>
        </div>
        <div className="space-y-2.5 p-5">
          {funnel.map((step, i) => (
            <FunnelBar key={i} label={step.label} count={step.count} maxCount={maxFunnel} />
          ))}
        </div>
      </section>

      {/* ── Step performance ───────────────────────────────── */}
      <section className="aurea-card mt-5 overflow-hidden">
        <div className="border-b border-aurea-border px-5 py-4">
          <h2 className="aurea-display text-[22px] text-aurea-ink">Step-by-step performance</h2>
        </div>
        {steps.length === 0 ? (
          <p className="py-10 text-center text-[13px] text-aurea-ink-3">No steps configured</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="border-aurea-border hover:bg-transparent">
                {['#', 'Step', 'Channel', 'Delay', 'Sent', 'Delivered', 'Opened', 'Replied', 'Reply %'].map((h, i) => (
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
              {steps.map((step) => (
                <TableRow key={step.step_number} className="border-aurea-border hover:bg-aurea-surface-2">
                  <TableCell className="font-mono text-[13px] tabular-nums text-aurea-ink-3">{step.step_number}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[13px] font-medium text-aurea-ink">{step.name}</span>
                      {step.ai_personalize && (
                        <span title="AI Personalized"><Sparkles className="h-3 w-3 text-aurea-gold" strokeWidth={1.75} /></span>
                      )}
                    </div>
                    <p className="mt-0.5 max-w-48 truncate text-[11.5px] text-aurea-ink-3">{step.body_preview}</p>
                  </TableCell>
                  <TableCell>
                    <span className="aurea-eyebrow">{step.channel === 'sms' ? 'SMS' : 'Email'}</span>
                  </TableCell>
                  <TableCell className="text-[12px] text-aurea-ink-3">
                    {step.delay_minutes < 60
                      ? `${step.delay_minutes}m`
                      : step.delay_minutes < 1440
                        ? `${Math.round(step.delay_minutes / 60)}h`
                        : `${Math.round(step.delay_minutes / 1440)}d`}
                  </TableCell>
                  <TableCell className="text-right font-mono text-[13px] tabular-nums text-aurea-ink-2">{step.total_sent}</TableCell>
                  <TableCell className="text-right font-mono text-[13px] tabular-nums text-aurea-ink-2">{step.total_delivered}</TableCell>
                  <TableCell className="text-right font-mono text-[13px] tabular-nums text-aurea-ink-2">{step.total_opened}</TableCell>
                  <TableCell className="text-right font-mono text-[13px] tabular-nums text-aurea-ink">{step.total_replied}</TableCell>
                  <TableCell className={`text-right font-mono text-[13px] tabular-nums ${parseFloat(step.reply_rate) > 10 ? 'text-aurea-primary' : 'text-aurea-ink-2'}`}>{step.reply_rate}%</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      {/* ── Exit reasons ───────────────────────────────────── */}
      {Object.keys(enrollments.exitReasons).length > 0 && (
        <section className="aurea-card mt-5 overflow-hidden">
          <div className="border-b border-aurea-border px-5 py-4">
            <h2 className="aurea-display text-[22px] text-aurea-ink">Exit reasons</h2>
          </div>
          <div className="px-5">
            {Object.entries(enrollments.exitReasons)
              .sort(([, a], [, b]) => b - a)
              .map(([reason, count]) => (
                <div key={reason} className="flex items-center justify-between border-b border-aurea-border py-3.5 last:border-0">
                  <span className="text-[13px] text-aurea-ink-2">{reason}</span>
                  <span className="font-mono text-[13px] tabular-nums text-aurea-ink">{count}</span>
                </div>
              ))}
          </div>
        </section>
      )}
    </div>
  )
}
