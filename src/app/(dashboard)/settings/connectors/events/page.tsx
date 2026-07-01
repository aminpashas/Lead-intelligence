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
  google_ads: { name: 'Google Ads', icon: Megaphone, color: 'text-aurea-ink-2' },
  meta_capi: { name: 'Meta CAPI', icon: Megaphone, color: 'text-aurea-primary' },
  ga4: { name: 'GA4', icon: BarChart3, color: 'text-aurea-amber' },
  outbound_webhook: { name: 'Webhook', icon: Webhook, color: 'text-aurea-primary' },
  slack: { name: 'Slack', icon: MessageSquare, color: 'text-aurea-ink-2' },
  google_reviews: { name: 'Reviews', icon: Activity, color: 'text-aurea-amber' },
  callrail: { name: 'CallRail', icon: Activity, color: 'text-aurea-ink-3' },
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
    <div className="max-w-5xl animate-in fade-in-0 duration-500">
      {/* Page header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-4">
          <Link href="/settings/connectors" className="text-aurea-ink-3 hover:text-aurea-ink transition-colors">
            <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          </Link>
          <Activity className="h-[18px] w-[18px] text-aurea-ink-3" strokeWidth={1.75} />
        </div>
        <p className="aurea-eyebrow mb-2">Connectors</p>
        <h1 className="aurea-display text-[32px] text-aurea-ink">Event Log</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-aurea-ink-2">
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
              <div
                key={type}
                className={`aurea-card p-3 ${stats.failed > 0 ? 'border-aurea-rose/30' : ''}`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <display.icon className={`h-3.5 w-3.5 ${display.color}`} strokeWidth={1.75} />
                  <span className="text-xs font-medium text-aurea-ink">{display.name}</span>
                </div>
                <div className="flex items-center justify-between text-xs font-mono tabular-nums">
                  <span className="text-aurea-primary font-medium">{stats.success} ✓</span>
                  {stats.failed > 0 && (
                    <span className="text-aurea-rose font-medium">{stats.failed} ✗</span>
                  )}
                  <span className="text-aurea-ink-3">{stats.total} total</span>
                </div>
              </div>
            )
          })}
          {Object.keys(data.stats.byConnector).length === 0 && (
            <p className="text-sm text-aurea-ink-3 col-span-5 text-center py-4">
              No events in the last 24 hours
            </p>
          )}
        </div>
      )}

      {/* Filters */}
      <div className="aurea-card mb-4 p-3">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-aurea-ink-3" strokeWidth={1.75} />
            <span className="text-sm font-medium text-aurea-ink-2">Filters:</span>
          </div>

          <select
            value={filterConnector}
            onChange={(e) => { setFilterConnector(e.target.value); setOffset(0) }}
            className="text-xs bg-aurea-surface-2 border border-aurea-border rounded px-2 py-1.5 text-aurea-ink-2"
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
            className="text-xs bg-aurea-surface-2 border border-aurea-border rounded px-2 py-1.5 text-aurea-ink-2"
          >
            <option value="">All Status</option>
            <option value="true">Success</option>
            <option value="false">Failed</option>
          </select>

          <Button
            variant="ghost"
            size="sm"
            onClick={fetchEvents}
            className="h-7 gap-1 ml-auto text-aurea-ink-2 hover:text-aurea-ink"
          >
            <RefreshCw className="h-3 w-3" strokeWidth={1.75} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Event List */}
      <Card className="shadow-none border-aurea-border">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-[14px] font-semibold text-aurea-ink">Recent Events</CardTitle>
              <CardDescription className="text-xs text-aurea-ink-3">
                <span className="font-mono tabular-nums">{data?.pagination?.total || 0}</span> total events
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-aurea-ink-3" strokeWidth={1.75} />
            </div>
          ) : (data?.events?.length || 0) === 0 ? (
            <div className="text-center py-10 text-aurea-ink-3 text-sm">
              <Activity className="h-8 w-8 mx-auto mb-2 opacity-30" strokeWidth={1.75} />
              <p>No connector events yet</p>
              <p className="text-xs mt-1 text-aurea-ink-3">Events will appear here once connectors are configured and leads start flowing</p>
            </div>
          ) : (
            <div className="space-y-0">
              {data?.events.map((event) => {
                const display = CONNECTOR_DISPLAY[event.connector_type] || {
                  name: event.connector_type, icon: Activity, color: 'text-aurea-ink-3',
                }
                return (
                  <div
                    key={event.id}
                    className="flex items-center gap-3 py-2.5 border-b border-aurea-border last:border-0 hover:bg-aurea-surface-2 rounded px-2 -mx-2 transition-colors"
                  >
                    {/* Status Icon */}
                    {event.success ? (
                      <CheckCircle2 className="h-4 w-4 text-aurea-primary shrink-0" strokeWidth={1.75} />
                    ) : (
                      <XCircle className="h-4 w-4 text-aurea-rose shrink-0" strokeWidth={1.75} />
                    )}

                    {/* Connector Badge */}
                    <Badge variant="outline" className="text-[10px] gap-1 shrink-0 border-aurea-border text-aurea-ink-3">
                      <display.icon className={`h-2.5 w-2.5 ${display.color}`} strokeWidth={1.75} />
                      {display.name}
                    </Badge>

                    {/* Event Type */}
                    <span className="text-xs font-medium text-aurea-ink shrink-0">
                      {EVENT_LABELS[event.event_type] || event.event_type}
                    </span>

                    {/* Lead Name */}
                    {event.leads && (
                      <span className="text-xs text-aurea-ink-3 truncate">
                        → {event.leads.first_name} {event.leads.last_name}
                      </span>
                    )}

                    {/* Spacer */}
                    <span className="flex-1" />

                    {/* Error Message */}
                    {event.error_message && (
                      <span
                        className="text-[10px] text-aurea-rose max-w-[200px] truncate"
                        title={event.error_message}
                      >
                        {event.error_message}
                      </span>
                    )}

                    {/* HTTP Status */}
                    {event.status_code && (
                      <Badge
                        variant={event.status_code < 300 ? 'default' : 'secondary'}
                        className="text-[10px] h-4 px-1 font-mono tabular-nums"
                      >
                        {event.status_code}
                      </Badge>
                    )}

                    {/* Timestamp */}
                    <span className="text-[10px] text-aurea-ink-3 font-mono tabular-nums shrink-0">
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
              <Separator className="my-3 bg-aurea-border" />
              <div className="flex items-center justify-between text-xs">
                <span className="text-aurea-ink-3 font-mono tabular-nums">
                  Showing {offset + 1}–{Math.min(offset + 50, data.pagination.total)} of {data.pagination.total}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 border-aurea-border text-aurea-ink-2 hover:text-aurea-ink hover:bg-aurea-surface-2"
                    disabled={offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - 50))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 border-aurea-border text-aurea-ink-2 hover:text-aurea-ink hover:bg-aurea-surface-2"
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
