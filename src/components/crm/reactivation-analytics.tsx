'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  ArrowLeft, ArrowRight, Upload, Users, MessageSquare,
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
        <Loader2 className="h-8 w-8 animate-spin text-purple-600" />
      </div>
    )
  }

  if (!data) {
    return (
      <div className="text-center py-24">
        <p className="text-muted-foreground">Failed to load campaign data</p>
        <Button variant="outline" onClick={onBack} className="mt-4">Go Back</Button>
      </div>
    )
  }

  const { campaign, enrollments, step_stats, funnel } = data
  const maxFunnelValue = Math.max(funnel.uploaded, 1)

  return (
    <div className="space-y-6" id="reactivation-analytics">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold">{campaign.name}</h1>
              <Badge className={
                campaign.status === 'active' ? 'bg-emerald-100 text-emerald-700' :
                campaign.status === 'paused' ? 'bg-amber-100 text-amber-700' :
                'bg-gray-100 text-gray-700'
              }>
                {campaign.status}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">{campaign.description}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{campaign.goal.replace(/_/g, ' ')}</Badge>
          <Badge variant="outline">{campaign.tone}</Badge>
        </div>
      </div>

      {/* ─── Key Metrics ─────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        {[
          { label: 'Uploaded', value: funnel.uploaded, icon: Upload, color: 'text-slate-600', bg: 'bg-slate-50' },
          { label: 'Enrolled', value: funnel.enrolled, icon: Users, color: 'text-blue-600', bg: 'bg-blue-50' },
          { label: 'Contacted', value: funnel.contacted, icon: MessageSquare, color: 'text-indigo-600', bg: 'bg-indigo-50' },
          { label: 'Responded', value: funnel.responded, icon: Zap, color: 'text-amber-600', bg: 'bg-amber-50' },
          { label: 'Reactivated', value: funnel.reactivated, icon: RefreshCw, color: 'text-purple-600', bg: 'bg-purple-50' },
          { label: 'Converted', value: funnel.converted, icon: Target, color: 'text-emerald-600', bg: 'bg-emerald-50' },
        ].map(m => (
          <Card key={m.label}>
            <CardContent className="py-4 px-4">
              <div className="flex items-center gap-2 mb-1">
                <div className={`h-7 w-7 rounded-lg ${m.bg} flex items-center justify-center`}>
                  <m.icon className={`h-3.5 w-3.5 ${m.color}`} />
                </div>
                <span className="text-xs text-muted-foreground">{m.label}</span>
              </div>
              <p className="text-2xl font-bold">{m.value.toLocaleString()}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ─── Reactivation Funnel ──────────────── */}
      <Card>
        <CardContent className="pt-5">
          <h3 className="font-semibold mb-4 flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-purple-600" />
            Reactivation Funnel
          </h3>
          <div className="space-y-3">
            {[
              { label: 'Uploaded', value: funnel.uploaded, color: 'bg-slate-400' },
              { label: 'Enrolled', value: funnel.enrolled, color: 'bg-blue-500' },
              { label: 'Contacted', value: funnel.contacted, color: 'bg-indigo-500' },
              { label: 'Responded', value: funnel.responded, color: 'bg-amber-500' },
              { label: 'Reactivated', value: funnel.reactivated, color: 'bg-purple-500' },
              { label: 'Converted', value: funnel.converted, color: 'bg-emerald-500' },
            ].map((item, i) => {
              const width = maxFunnelValue > 0 ? Math.max((item.value / maxFunnelValue) * 100, 2) : 2
              const prevValue = i > 0 ? [funnel.uploaded, funnel.enrolled, funnel.contacted, funnel.responded, funnel.reactivated, funnel.converted][i - 1] : null
              const convRate = prevValue && prevValue > 0 ? ((item.value / prevValue) * 100).toFixed(1) : null

              return (
                <div key={item.label} className="flex items-center gap-3">
                  <div className="w-24 text-sm text-right">
                    <span className="font-medium">{item.label}</span>
                  </div>
                  <div className="flex-1 relative">
                    <div className="h-8 bg-slate-100 rounded-lg overflow-hidden">
                      <div
                        className={`h-full ${item.color} rounded-lg transition-all duration-700 flex items-center justify-end pr-2`}
                        style={{ width: `${width}%` }}
                      >
                        {width > 15 && (
                          <span className="text-xs text-white font-medium">{item.value.toLocaleString()}</span>
                        )}
                      </div>
                    </div>
                    {width <= 15 && (
                      <span className="text-xs font-medium ml-2 absolute left-0 top-1/2 -translate-y-1/2" style={{ left: `${width + 2}%` }}>
                        {item.value.toLocaleString()}
                      </span>
                    )}
                  </div>
                  <div className="w-16 text-right">
                    {convRate && (
                      <span className="text-xs text-muted-foreground">{convRate}%</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* ─── Step Performance ────────────────── */}
      {step_stats.length > 0 && (
        <Card>
          <CardContent className="pt-5">
            <h3 className="font-semibold mb-4 flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-purple-600" />
              Step Performance
            </h3>
            <div className="space-y-2">
              {step_stats.map((step) => {
                const replyRate = step.total_sent > 0 ? ((step.total_replied / step.total_sent) * 100).toFixed(1) : '0.0'
                const openRate = step.total_sent > 0 ? ((step.total_opened / step.total_sent) * 100).toFixed(1) : '0.0'

                return (
                  <div key={step.step_number} className="flex items-center gap-4 py-2.5 border-b last:border-0">
                    <Badge variant="outline" className="w-20 justify-center text-xs gap-1 shrink-0">
                      {step.channel === 'sms' ? <MessageSquare className="h-3 w-3" /> : <Mail className="h-3 w-3" />}
                      Step {step.step_number}
                    </Badge>
                    <span className="text-sm font-medium flex-1 min-w-0 truncate">{step.name}</span>

                    <div className="flex items-center gap-6 text-xs shrink-0">
                      <div className="text-center">
                        <p className="font-semibold">{step.total_sent}</p>
                        <p className="text-muted-foreground">Sent</p>
                      </div>
                      {step.channel === 'email' && (
                        <div className="text-center">
                          <p className="font-semibold">{openRate}%</p>
                          <p className="text-muted-foreground">Opened</p>
                        </div>
                      )}
                      <div className="text-center">
                        <p className="font-semibold text-emerald-600">{step.total_replied}</p>
                        <p className="text-muted-foreground">Replied</p>
                      </div>
                      <div className="text-center">
                        <p className={`font-semibold ${parseFloat(replyRate) > 5 ? 'text-emerald-600' : 'text-muted-foreground'}`}>
                          {replyRate}%
                        </p>
                        <p className="text-muted-foreground">Rate</p>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ─── Enrollment Breakdown ────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardContent className="pt-5">
            <h3 className="font-semibold mb-4 flex items-center gap-2">
              <Users className="h-4 w-4 text-purple-600" />
              Enrollment Status
            </h3>
            <div className="space-y-2">
              {[
                { label: 'Active', value: enrollments.active, color: 'bg-emerald-500' },
                { label: 'Completed', value: enrollments.completed, color: 'bg-blue-500' },
                { label: 'Exited (replied)', value: enrollments.exited, color: 'bg-amber-500' },
                { label: 'Unsubscribed', value: enrollments.unsubscribed, color: 'bg-red-500' },
              ].map(item => (
                <div key={item.label} className="flex items-center justify-between py-1.5">
                  <div className="flex items-center gap-2">
                    <div className={`h-2.5 w-2.5 rounded-full ${item.color}`} />
                    <span className="text-sm">{item.label}</span>
                  </div>
                  <span className="text-sm font-medium">{item.value.toLocaleString()}</span>
                </div>
              ))}
              <div className="border-t pt-2 flex justify-between">
                <span className="text-sm font-medium">Total</span>
                <span className="text-sm font-bold">{enrollments.total.toLocaleString()}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Offers Performance */}
        <Card>
          <CardContent className="pt-5">
            <h3 className="font-semibold mb-4 flex items-center gap-2">
              <Gift className="h-4 w-4 text-pink-500" />
              Offer Performance
            </h3>
            {campaign.offers && campaign.offers.length > 0 ? (
              <div className="space-y-3">
                {campaign.offers.map((offer) => (
                  <div key={offer.id} className="flex items-center justify-between py-1.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <Badge variant="outline" className="text-xs shrink-0">
                        {offer.type === 'percentage_off' ? `${offer.value}% off` :
                         offer.type === 'dollar_off' ? `$${offer.value} off` :
                         offer.type === 'free_addon' ? 'Free' :
                         offer.type === 'financing_special' ? 'Finance' :
                         'Limited'}
                      </Badge>
                      <span className="text-sm truncate">{offer.name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{offer.times_used} used</span>
                      {offer.is_active ? (
                        <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
                      ) : (
                        <span className="text-xs text-muted-foreground">Inactive</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground py-4 text-center">No offers configured</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Back button */}
      <div className="flex justify-start">
        <Button variant="outline" onClick={onBack} className="gap-2">
          <ArrowLeft className="h-4 w-4" />
          Back to Campaigns
        </Button>
      </div>
    </div>
  )
}
