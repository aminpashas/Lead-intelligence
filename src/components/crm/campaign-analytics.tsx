'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import {
  Send,
  CheckCircle,
  XCircle,
  Pause,
  Users,
  TrendingUp,
  MessageSquare,
  Mail,
  ArrowLeft,
  Sparkles,
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

function FunnelBar({ label, count, maxCount }: { label: string; count: number; maxCount: number }) {
  const pct = maxCount > 0 ? (count / maxCount) * 100 : 0
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm w-24 text-right text-muted-foreground">{label}</span>
      <div className="flex-1 h-8 bg-muted rounded relative overflow-hidden">
        <div
          className="h-full bg-primary/80 rounded transition-all"
          style={{ width: `${pct}%` }}
        />
        <span className="absolute inset-0 flex items-center justify-center text-xs font-medium">
          {count} ({pct.toFixed(0)}%)
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
    return <div className="text-center py-12 text-muted-foreground">Loading campaign analytics...</div>
  }

  if (!stats) {
    return <div className="text-center py-12 text-muted-foreground">Campaign not found</div>
  }

  const { campaign, enrollments, steps, funnel } = stats
  const maxFunnel = funnel.length > 0 ? Math.max(...funnel.map((f) => f.count), 1) : 1

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        <div>
          <h2 className="text-xl font-bold">{campaign.name}</h2>
          <div className="flex items-center gap-2 mt-0.5">
            <Badge variant={campaign.status === 'active' ? 'default' : 'secondary'}>
              {campaign.status}
            </Badge>
            <Badge variant="outline">{campaign.type}</Badge>
            <Badge variant="outline">
              {campaign.channel === 'sms' ? <MessageSquare className="h-3 w-3 mr-1" /> : <Mail className="h-3 w-3 mr-1" />}
              {campaign.channel}
            </Badge>
          </div>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card>
          <CardContent className="pt-4 text-center">
            <Users className="h-5 w-5 mx-auto mb-1 text-blue-500" />
            <p className="text-2xl font-bold">{enrollments.total}</p>
            <p className="text-xs text-muted-foreground">Enrolled</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 text-center">
            <Send className="h-5 w-5 mx-auto mb-1 text-green-500" />
            <p className="text-2xl font-bold">{enrollments.active}</p>
            <p className="text-xs text-muted-foreground">Active</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 text-center">
            <CheckCircle className="h-5 w-5 mx-auto mb-1 text-emerald-500" />
            <p className="text-2xl font-bold">{enrollments.completed}</p>
            <p className="text-xs text-muted-foreground">Completed</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 text-center">
            <XCircle className="h-5 w-5 mx-auto mb-1 text-red-500" />
            <p className="text-2xl font-bold">{enrollments.exited}</p>
            <p className="text-xs text-muted-foreground">Exited</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 text-center">
            <TrendingUp className="h-5 w-5 mx-auto mb-1 text-purple-500" />
            <p className="text-2xl font-bold">{campaign.total_converted || 0}</p>
            <p className="text-xs text-muted-foreground">Converted</p>
          </CardContent>
        </Card>
      </div>

      {/* Conversion Funnel */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Conversion Funnel</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {funnel.map((step, i) => (
            <FunnelBar key={i} label={step.label} count={step.count} maxCount={maxFunnel} />
          ))}
        </CardContent>
      </Card>

      {/* Step Performance Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Step-by-Step Performance</CardTitle>
        </CardHeader>
        <CardContent>
          {steps.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">No steps configured</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>Step</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Delay</TableHead>
                  <TableHead className="text-right">Sent</TableHead>
                  <TableHead className="text-right">Delivered</TableHead>
                  <TableHead className="text-right">Opened</TableHead>
                  <TableHead className="text-right">Replied</TableHead>
                  <TableHead className="text-right">Reply Rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {steps.map((step) => (
                  <TableRow key={step.step_number}>
                    <TableCell className="font-medium">{step.step_number}</TableCell>
                    <TableCell>
                      <div>
                        <span className="text-sm">{step.name}</span>
                        {step.ai_personalize && (
                          <span title="AI Personalized"><Sparkles className="h-3 w-3 inline ml-1 text-amber-500" /></span>
                        )}
                        <p className="text-xs text-muted-foreground truncate max-w-48">{step.body_preview}</p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">
                        {step.channel === 'sms' ? 'SMS' : 'Email'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {step.delay_minutes < 60
                        ? `${step.delay_minutes}m`
                        : step.delay_minutes < 1440
                          ? `${Math.round(step.delay_minutes / 60)}h`
                          : `${Math.round(step.delay_minutes / 1440)}d`}
                    </TableCell>
                    <TableCell className="text-right">{step.total_sent}</TableCell>
                    <TableCell className="text-right">{step.total_delivered}</TableCell>
                    <TableCell className="text-right">{step.total_opened}</TableCell>
                    <TableCell className="text-right">{step.total_replied}</TableCell>
                    <TableCell className="text-right">
                      <Badge
                        variant={parseFloat(step.reply_rate) > 10 ? 'default' : 'secondary'}
                        className="text-xs"
                      >
                        {step.reply_rate}%
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Exit Reasons */}
      {Object.keys(enrollments.exitReasons).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Exit Reasons</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {Object.entries(enrollments.exitReasons)
                .sort(([, a], [, b]) => b - a)
                .map(([reason, count]) => (
                  <div key={reason} className="flex items-center justify-between">
                    <span className="text-sm">{reason}</span>
                    <Badge variant="secondary">{count}</Badge>
                  </div>
                ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
