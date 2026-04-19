'use client'

import { useEffect, useState, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Activity,
  RefreshCw,
  Loader2,
  Filter,
  Megaphone,
  BarChart3,
  MessageSquare,
  Webhook,
  type LucideIcon,
} from 'lucide-react'
import Link from 'next/link'

type ConnectorEvent = {
  id: string
  connector_type: string
  event_type: string
  success: boolean
  status_code: number | null
  error_message: string | null
  response_id: string | null
  dispatched_at: string
  leads: { id: string; first_name: string; last_name: string } | null
}

type EventsResponse = {
  events: ConnectorEvent[]
  stats: {
    total: number
    byConnector: Record<string, { total: number; success: number; failed: number }>
    byEvent: Record<string, number>
  }
  pagination: { limit: number; offset: number; total: number }
}

const CONNECTOR_DISPLAY: Record<string, { name: string; icon: LucideIcon; color: string }> = {
  google_ads: { name: 'Google Ads', icon: Megaphone, color: 'text-blue-500' },
  meta_capi: { name: 'Meta CAPI', icon: Megaphone, color: 'text-indigo-500' },
  ga4: { name: 'GA4', icon: BarChart3, color: 'text-orange-500' },
  outbound_webhook: { name: 'Webhook', icon: Webhook, color: 'text-emerald-500' },
  slack: { name: 'Slack', icon: MessageSquare, color: 'text-purple-500' },
  google_reviews: { name: 'Reviews', icon: Activity, color: 'text-yellow-500' },
  callrail: { name: 'CallRail', icon: Activity, color: 'text-teal-500' },
}

const EVENT_LABELS: Record<string, string> = {
  'lead.created': 'Lead Created',
  'lead.qualified': 'Lead Qualified',
  'stage.changed': 'Stage Changed',
  'consultation.scheduled': 'Consultation Booked',
  'consultation.completed': 'Consultation Done',
  'consultation.no_show': 'No-Show',
  'treatment.presented': 'Treatment Presented',
  'treatment.accepted': 'Treatment Accepted',
  'contract.signed': 'Contract Signed',
  'treatment.completed': 'Treatment Completed',
  'lead.lost': 'Lead Lost',
  'appointment.booked': 'Appointment Booked',
  'payment.received': 'Payment Received',
}

export default function ConnectorEventsPage() {
  const [data, setData] = useState<EventsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [filterConnector, setFilterConnector] = useState<string>('')
  const [filterSuccess, setFilterSuccess] = useState<string>('')
  const [offset, setOffset] = useState(0)

  const fetchEvents = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (filterConnector) params.set('connector', filterConnector)
      if (filterSuccess) params.set('success', filterSuccess)
      params.set('limit', '50')
      params.set('offset', String(offset))

      const res = await fetch(`/api/connectors/events?${params}`)
      if (res.ok) {
        setData(await res.json())
      }
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }, [filterConnector, filterSuccess, offset])

  useEffect(() => {
    fetchEvents()
  }, [fetchEvents])

  return (
    <div className="max-w-5xl">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <Link href="/settings/connectors" className="text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <Activity className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold">Connector Event Log</h1>
        </div>
        <p className="text-muted-foreground ml-[52px]">
          Real-time audit trail of every event dispatched to your connected platforms
        </p>
      </div>

      {/* 24h Stats */}
      {data?.stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
          {Object.entries(data.stats.byConnector).map(([type, stats]) => {
            const display = CONNECTOR_DISPLAY[type]
            if (!display) return null
            return (
              <Card key={type} className={stats.failed > 0 ? 'border-red-200' : ''}>
                <CardContent className="py-3">
                  <div className="flex items-center gap-2 mb-2">
                    <display.icon className={`h-3.5 w-3.5 ${display.color}`} />
                    <span className="text-xs font-medium">{display.name}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-green-600 font-medium">{stats.success} ✓</span>
                    {stats.failed > 0 && (
                      <span className="text-red-500 font-medium">{stats.failed} ✗</span>
                    )}
                    <span className="text-muted-foreground">{stats.total} total</span>
                  </div>
                </CardContent>
              </Card>
            )
          })}
          {Object.keys(data.stats.byConnector).length === 0 && (
            <p className="text-sm text-muted-foreground col-span-5 text-center py-4">
              No events in the last 24 hours
            </p>
          )}
        </div>
      )}

      {/* Filters */}
      <Card className="mb-4">
        <CardContent className="py-3">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Filters:</span>
            </div>

            <select
              value={filterConnector}
              onChange={(e) => { setFilterConnector(e.target.value); setOffset(0) }}
              className="text-xs bg-muted border rounded px-2 py-1.5"
            >
              <option value="">All Connectors</option>
              <option value="google_ads">Google Ads</option>
              <option value="meta_capi">Meta CAPI</option>
              <option value="ga4">GA4</option>
              <option value="outbound_webhook">Webhooks</option>
              <option value="slack">Slack</option>
            </select>

            <select
              value={filterSuccess}
              onChange={(e) => { setFilterSuccess(e.target.value); setOffset(0) }}
              className="text-xs bg-muted border rounded px-2 py-1.5"
            >
              <option value="">All Status</option>
              <option value="true">Success</option>
              <option value="false">Failed</option>
            </select>

            <Button variant="ghost" size="sm" onClick={fetchEvents} className="h-7 gap-1 ml-auto">
              <RefreshCw className="h-3 w-3" />
              Refresh
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Event List */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Recent Events</CardTitle>
              <CardDescription className="text-xs">
                {data?.pagination?.total || 0} total events
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (data?.events?.length || 0) === 0 ? (
            <div className="text-center py-10 text-muted-foreground text-sm">
              <Activity className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>No connector events yet</p>
              <p className="text-xs mt-1">Events will appear here once connectors are configured and leads start flowing</p>
            </div>
          ) : (
            <div className="space-y-0">
              {data?.events.map((event) => {
                const display = CONNECTOR_DISPLAY[event.connector_type] || {
                  name: event.connector_type, icon: Activity, color: 'text-muted-foreground',
                }
                return (
                  <div
                    key={event.id}
                    className="flex items-center gap-3 py-2.5 border-b last:border-0 hover:bg-muted/30 rounded px-2 -mx-2 transition-colors"
                  >
                    {/* Status Icon */}
                    {event.success ? (
                      <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                    ) : (
                      <XCircle className="h-4 w-4 text-red-500 shrink-0" />
                    )}

                    {/* Connector Badge */}
                    <Badge variant="outline" className="text-[10px] gap-1 shrink-0">
                      <display.icon className={`h-2.5 w-2.5 ${display.color}`} />
                      {display.name}
                    </Badge>

                    {/* Event Type */}
                    <span className="text-xs font-medium shrink-0">
                      {EVENT_LABELS[event.event_type] || event.event_type}
                    </span>

                    {/* Lead Name */}
                    {event.leads && (
                      <span className="text-xs text-muted-foreground truncate">
                        → {event.leads.first_name} {event.leads.last_name}
                      </span>
                    )}

                    {/* Spacer */}
                    <span className="flex-1" />

                    {/* Error Message */}
                    {event.error_message && (
                      <span
                        className="text-[10px] text-red-500 max-w-[200px] truncate"
                        title={event.error_message}
                      >
                        {event.error_message}
                      </span>
                    )}

                    {/* HTTP Status */}
                    {event.status_code && (
                      <Badge
                        variant={event.status_code < 300 ? 'default' : 'secondary'}
                        className="text-[10px] h-4 px-1"
                      >
                        {event.status_code}
                      </Badge>
                    )}

                    {/* Timestamp */}
                    <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                      {new Date(event.dispatched_at).toLocaleString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                )
              })}
            </div>
          )}

          {/* Pagination */}
          {data && data.pagination.total > data.pagination.limit && (
            <>
              <Separator className="my-3" />
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">
                  Showing {offset + 1}–{Math.min(offset + 50, data.pagination.total)} of {data.pagination.total}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7"
                    disabled={offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - 50))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7"
                    disabled={offset + 50 >= data.pagination.total}
                    onClick={() => setOffset(offset + 50)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
