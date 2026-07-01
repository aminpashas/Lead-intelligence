'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import {
  ArrowLeft, Upload, Users, MessageSquare,
  Zap, Target, RefreshCw, Loader2, Gift, Mail,
  TrendingUp, BarChart3, CheckCircle,
} from 'lucide-react'

type StepStat = {
  step_number: number
  name: string
  channel: string
  total_sent: number
  total_delivered: number
  total_opened: number
  total_replied: number
}

type StatsData = {
  campaign: {
    id: string
    name: string
    description: string | null
    goal: string
    tone: string
    status: string
    total_uploaded: number
    total_reactivated: number
    total_responded: number
    total_converted: number
    offers: Array<{ id: string; name: string; type: string; value: number; times_used: number; is_active: boolean }>
  }
  enrollments: { total: number; active: number; completed: number; exited: number; unsubscribed: number }
  step_stats: StepStat[]
  funnel: { uploaded: number; enrolled: number; contacted: number; responded: number; reactivated: number; converted: number }
}

export function ReactivationAnalytics({
  campaignId,
  onBack,
}: {
  campaignId: string
  onBack: () => void
}) {
  const [data, setData] = useState<StatsData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchStats() {
      try {
        const res = await fetch(`/api/reactivation/${campaignId}/stats`)
        if (res.ok) {
          const json = await res.json()
          setData(json)
        }
      } catch {
        // silent fail
      } finally {
        setLoading(false)
      }
    }
    fetchStats()
  }, [campaignId])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-7 w-7 animate-spin text-aurea-primary" />
      </div>
    )
  }

  if (!data) {
    return (
      <div className="text-center py-24">
        <p className="text-aurea-ink-3">Failed to load campaign data</p>
        <Button variant="outline" onClick={onBack} className="mt-4">Go Back</Button>
      </div>
    )
  }

  const { campaign, enrollments, step_stats, funnel } = data
  const maxFunnelValue = Math.max(funnel.uploaded, 1)

  const statusTone: Record<string, { dot: string; ink: string }> = {
    active: { dot: 'bg-aurea-primary', ink: 'text-aurea-primary' },
    paused: { dot: 'bg-aurea-amber', ink: 'text-aurea-amber' },
  }
  const st = statusTone[campaign.status] ?? { dot: 'bg-aurea-ink-3', ink: 'text-aurea-ink-3' }

  return (
    <div id="reactivation-analytics">
      {/* Header */}
      <div className="flex flex-col gap-4 border-b border-aurea-border pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          <Button variant="ghost" size="icon" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          </Button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="aurea-display text-[32px] text-aurea-ink">{campaign.name}</h1>
              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium capitalize">
                <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} />
                <span className={st.ink}>{campaign.status}</span>
              </span>
            </div>
            {campaign.description && (
              <p className="mt-1 text-[13px] text-aurea-ink-3">{campaign.description}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wide text-aurea-ink-3 sm:pt-2">
          <span>{campaign.goal.replace(/_/g, ' ')}</span>
          <span className="text-aurea-border-strong">·</span>
          <span>{campaign.tone}</span>
        </div>
      </div>

      {/* ─── Key Metrics ─────────────────────── */}
      <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: 'Uploaded', value: funnel.uploaded, icon: Upload },
          { label: 'Enrolled', value: funnel.enrolled, icon: Users },
          { label: 'Contacted', value: funnel.contacted, icon: MessageSquare },
          { label: 'Responded', value: funnel.responded, icon: Zap },
          { label: 'Reactivated', value: funnel.reactivated, icon: RefreshCw },
          { label: 'Converted', value: funnel.converted, icon: Target, accent: true },
        ].map(m => (
          <div key={m.label} className="aurea-card p-4">
            <div className="flex items-center justify-between">
              <p className="aurea-eyebrow !tracking-[0.1em]">{m.label}</p>
              <m.icon className="h-[15px] w-[15px] text-aurea-ink-3" strokeWidth={1.75} />
            </div>
            <p className={`aurea-display mt-3 text-[28px] tabular-nums ${m.accent ? 'text-aurea-primary' : 'text-aurea-ink'}`}>
              {m.value.toLocaleString()}
            </p>
          </div>
        ))}
      </div>

      {/* ─── Reactivation Funnel ──────────────── */}
      <section className="aurea-card mt-5 p-5">
        <h3 className="aurea-eyebrow mb-5 flex items-center gap-2">
          <TrendingUp className="h-3.5 w-3.5 text-aurea-ink-3" strokeWidth={1.75} />
          Reactivation Funnel
        </h3>
        <div className="space-y-2.5">
          {[
            { label: 'Uploaded', value: funnel.uploaded },
            { label: 'Enrolled', value: funnel.enrolled },
            { label: 'Contacted', value: funnel.contacted },
            { label: 'Responded', value: funnel.responded },
            { label: 'Reactivated', value: funnel.reactivated },
            { label: 'Converted', value: funnel.converted, accent: true },
          ].map((item, i) => {
            const width = maxFunnelValue > 0 ? Math.max((item.value / maxFunnelValue) * 100, 1.5) : 1.5
            const prevValue = i > 0 ? [funnel.uploaded, funnel.enrolled, funnel.contacted, funnel.responded, funnel.reactivated, funnel.converted][i - 1] : null
            const convRate = prevValue && prevValue > 0 ? ((item.value / prevValue) * 100).toFixed(1) : null

            return (
              <div key={item.label} className="flex items-center gap-3">
                <div className="w-24 shrink-0 text-right text-[12px] font-medium text-aurea-ink-2">{item.label}</div>
                <div className="h-7 flex-1 overflow-hidden rounded-md bg-aurea-surface-2">
                  <div
                    className={`h-full rounded-md transition-all duration-700 ${item.accent ? 'bg-aurea-primary' : 'bg-aurea-ink/85'}`}
                    style={{ width: `${width}%` }}
                  />
                </div>
                <div className="w-16 shrink-0 text-right font-mono text-[12px] tabular-nums text-aurea-ink">
                  {item.value.toLocaleString()}
                </div>
                <div className="w-12 shrink-0 text-right font-mono text-[11px] tabular-nums text-aurea-ink-3">
                  {convRate ? `${convRate}%` : ''}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {/* ─── Step Performance ────────────────── */}
      {step_stats.length > 0 && (
        <section className="aurea-card mt-5 p-5">
          <h3 className="aurea-eyebrow mb-4 flex items-center gap-2">
            <BarChart3 className="h-3.5 w-3.5 text-aurea-ink-3" strokeWidth={1.75} />
            Step Performance
          </h3>
          <div>
            {step_stats.map((step) => {
              const replyRate = step.total_sent > 0 ? ((step.total_replied / step.total_sent) * 100).toFixed(1) : '0.0'
              const openRate = step.total_sent > 0 ? ((step.total_opened / step.total_sent) * 100).toFixed(1) : '0.0'

              return (
                <div key={step.step_number} className="flex items-center gap-4 border-b border-aurea-border py-3 last:border-0">
                  <span className="inline-flex w-20 shrink-0 items-center justify-center gap-1.5 rounded-md bg-aurea-surface-2 px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-aurea-ink-2 ring-1 ring-aurea-border">
                    {step.channel === 'sms' ? <MessageSquare className="h-3 w-3" strokeWidth={1.75} /> : <Mail className="h-3 w-3" strokeWidth={1.75} />}
                    {step.step_number}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-aurea-ink">{step.name}</span>

                  <div className="flex shrink-0 items-center gap-6 text-center">
                    <div>
                      <p className="font-mono text-[13px] tabular-nums text-aurea-ink">{step.total_sent}</p>
                      <p className="aurea-eyebrow mt-0.5 !tracking-[0.1em]">Sent</p>
                    </div>
                    {step.channel === 'email' && (
                      <div>
                        <p className="font-mono text-[13px] tabular-nums text-aurea-ink">{openRate}%</p>
                        <p className="aurea-eyebrow mt-0.5 !tracking-[0.1em]">Opened</p>
                      </div>
                    )}
                    <div>
                      <p className="font-mono text-[13px] tabular-nums text-aurea-primary">{step.total_replied}</p>
                      <p className="aurea-eyebrow mt-0.5 !tracking-[0.1em]">Replied</p>
                    </div>
                    <div>
                      <p className={`font-mono text-[13px] tabular-nums ${parseFloat(replyRate) > 5 ? 'text-aurea-primary' : 'text-aurea-ink-3'}`}>
                        {replyRate}%
                      </p>
                      <p className="aurea-eyebrow mt-0.5 !tracking-[0.1em]">Rate</p>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* ─── Enrollment Breakdown ────────────── */}
      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        <section className="aurea-card p-5">
          <h3 className="aurea-eyebrow mb-4 flex items-center gap-2">
            <Users className="h-3.5 w-3.5 text-aurea-ink-3" strokeWidth={1.75} />
            Enrollment Status
          </h3>
          <div>
            {[
              { label: 'Active', value: enrollments.active, dot: 'bg-aurea-primary' },
              { label: 'Completed', value: enrollments.completed, dot: 'bg-aurea-gold' },
              { label: 'Exited (replied)', value: enrollments.exited, dot: 'bg-aurea-amber' },
              { label: 'Unsubscribed', value: enrollments.unsubscribed, dot: 'bg-aurea-rose' },
            ].map(item => (
              <div key={item.label} className="flex items-center justify-between py-1.5">
                <div className="flex items-center gap-2.5">
                  <span className={`h-1.5 w-1.5 rounded-full ${item.dot}`} />
                  <span className="text-[13px] text-aurea-ink-2">{item.label}</span>
                </div>
                <span className="font-mono text-[13px] tabular-nums text-aurea-ink">{item.value.toLocaleString()}</span>
              </div>
            ))}
            <div className="mt-1 flex justify-between border-t border-aurea-border pt-2.5">
              <span className="text-[13px] font-medium text-aurea-ink">Total</span>
              <span className="aurea-display text-[16px] tabular-nums text-aurea-ink">{enrollments.total.toLocaleString()}</span>
            </div>
          </div>
        </section>

        {/* Offers Performance */}
        <section className="aurea-card p-5">
          <h3 className="aurea-eyebrow mb-4 flex items-center gap-2">
            <Gift className="h-3.5 w-3.5 text-aurea-gold" strokeWidth={1.75} />
            Offer Performance
          </h3>
          {campaign.offers && campaign.offers.length > 0 ? (
            <div>
              {campaign.offers.map((offer) => (
                <div key={offer.id} className="flex items-center justify-between border-b border-aurea-border py-2.5 last:border-0">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="shrink-0 rounded-md bg-aurea-surface-2 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-aurea-ink-2 ring-1 ring-aurea-border">
                      {offer.type === 'percentage_off' ? `${offer.value}% off` :
                       offer.type === 'dollar_off' ? `$${offer.value} off` :
                       offer.type === 'free_addon' ? 'Free' :
                       offer.type === 'financing_special' ? 'Finance' :
                       'Limited'}
                    </span>
                    <span className="truncate text-[13px] text-aurea-ink">{offer.name}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="font-mono text-[12px] tabular-nums text-aurea-ink-2">{offer.times_used} used</span>
                    {offer.is_active ? (
                      <CheckCircle className="h-3.5 w-3.5 text-aurea-primary" strokeWidth={1.75} />
                    ) : (
                      <span className="text-[11px] text-aurea-ink-3">Inactive</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="py-4 text-center text-[13px] text-aurea-ink-3">No offers configured</p>
          )}
        </section>
      </div>

      {/* Back button */}
      <div className="mt-6 flex justify-start">
        <Button variant="outline" onClick={onBack} className="gap-2">
          <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          Back to Campaigns
        </Button>
      </div>
    </div>
  )
}
