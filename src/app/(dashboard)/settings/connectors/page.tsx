'use client'

import { useEffect, useState, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { toast } from 'sonner'
import {
  Plug,
  Megaphone,
  BarChart3,
  MessageSquare,
  Webhook,
  ArrowLeft,
  AlertTriangle,
  ExternalLink,
  Loader2,
  Save,
  Trash2,
  Activity,
  Star,
  Phone,
  Clock,
  type LucideIcon,
} from 'lucide-react'
import Link from 'next/link'

type ConnectorType = 'google_ads' | 'meta_capi' | 'ga4' | 'outbound_webhook' | 'slack' | 'google_reviews' | 'callrail'

type ConnectorInfo = {
  type: ConnectorType
  name: string
  description: string
  icon: LucideIcon
  color: string
  docsUrl: string
  fields: { key: string; label: string; placeholder: string; type?: string; required?: boolean }[]
  eventFields?: { key: string; label: string; options: { value: string; label: string }[] }[]
}

type ConnectorData = {
  connector_type: ConnectorType
  configured: boolean
  enabled: boolean
  settings: Record<string, unknown>
  id: string | null
  stats: { sent: number; failed: number }
  syncStatus: {
    last_synced_at: string | null
    last_success_at: string | null
    last_error: string | null
    rows_inserted_last_run: number | null
  } | null
}

const CONNECTOR_INFO: ConnectorInfo[] = [
  {
    type: 'google_ads',
    name: 'Google Ads',
    description: 'Push offline conversions back to Google Ads so Smart Bidding optimizes for real patient outcomes, not just form fills.',
    icon: Megaphone,
    color: 'text-blue-500',
    docsUrl: 'https://developers.google.com/google-ads/api/docs/conversions/upload-clicks',
    fields: [
      { key: 'customerId', label: 'Customer ID', placeholder: '123-456-7890 (no dashes)', required: true },
      { key: 'developerToken', label: 'Developer Token', placeholder: 'Your Google Ads developer token', type: 'password', required: true },
      { key: 'clientId', label: 'OAuth Client ID', placeholder: 'xxxx.apps.googleusercontent.com', required: true },
      { key: 'clientSecret', label: 'OAuth Client Secret', placeholder: 'GOCSPX-xxx', type: 'password', required: true },
      { key: 'refreshToken', label: 'Refresh Token', placeholder: '1//xxx', type: 'password', required: true },
      { key: 'loginCustomerId', label: 'MCC Account ID (optional)', placeholder: 'Leave blank if not using MCC' },
    ],
  },
  {
    type: 'meta_capi',
    name: 'Meta Conversions API',
    description: 'Server-side events to Facebook & Instagram that bypass iOS privacy restrictions and ad blockers — restores ~40% lost attribution.',
    icon: Megaphone,
    color: 'text-indigo-500',
    docsUrl: 'https://developers.facebook.com/docs/marketing-api/conversions-api',
    fields: [
      { key: 'pixelId', label: 'Pixel ID', placeholder: 'Your Meta pixel ID', required: true },
      { key: 'accessToken', label: 'Access Token', placeholder: 'System user access token', type: 'password', required: true },
      { key: 'testEventCode', label: 'Test Event Code (optional)', placeholder: 'TEST12345 — remove for production' },
    ],
  },
  {
    type: 'ga4',
    name: 'Google Analytics 4',
    description: 'Send CRM pipeline events to GA4 for full-funnel visibility — from ad click to consultation to case closed.',
    icon: BarChart3,
    color: 'text-orange-500',
    docsUrl: 'https://developers.google.com/analytics/devguides/collection/protocol/ga4',
    fields: [
      { key: 'measurementId', label: 'Measurement ID', placeholder: 'G-XXXXXXXXXX', required: true },
      { key: 'apiSecret', label: 'API Secret', placeholder: 'Measurement Protocol API secret', type: 'password', required: true },
    ],
  },
  {
    type: 'outbound_webhook',
    name: 'Outbound Webhooks',
    description: 'Send CRM events to any URL — connects to Zapier, Make.com, n8n, or your own systems without custom code.',
    icon: Webhook,
    color: 'text-emerald-500',
    docsUrl: '',
    fields: [
      { key: 'url', label: 'Webhook URL', placeholder: 'https://hooks.zapier.com/xxx or your endpoint', required: true },
      { key: 'secret', label: 'Signing Secret (optional)', placeholder: 'HMAC-SHA256 secret for signature verification' },
    ],
  },
  {
    type: 'slack',
    name: 'Slack Notifications',
    description: 'Real-time alerts to your team Slack channel — hot leads, consultations booked, cases closed, no-shows.',
    icon: MessageSquare,
    color: 'text-purple-500',
    docsUrl: 'https://api.slack.com/messaging/webhooks',
    fields: [
      { key: 'webhookUrl', label: 'Incoming Webhook URL', placeholder: 'https://hooks.slack.com/services/T.../B.../xxx', required: true },
      { key: 'channel', label: 'Channel Override (optional)', placeholder: '#lead-alerts' },
    ],
  },
  {
    type: 'google_reviews',
    name: 'Google Reviews',
    description: 'Automatically request Google reviews from patients after treatment — boosts your practice\'s online reputation.',
    icon: Star,
    color: 'text-yellow-500',
    docsUrl: 'https://developers.google.com/maps/documentation/places/web-service/place-id',
    fields: [
      { key: 'placeId', label: 'Google Place ID', placeholder: 'ChIJ... (find at Google Maps → Share → Embed)', required: true },
      { key: 'reviewUrl', label: 'Direct Review URL (auto-generated)', placeholder: 'Leave blank to auto-generate from Place ID' },
      { key: 'delayHours', label: 'Delay (hours after treatment)', placeholder: '2 (default)' },
    ],
  },
  {
    type: 'callrail',
    name: 'CallRail',
    description: 'Track phone calls from ads — know which campaigns, keywords, and landing pages drive phone conversions.',
    icon: Phone,
    color: 'text-teal-500',
    docsUrl: 'https://www.callrail.com/apidocs',
    fields: [
      { key: 'companyId', label: 'CallRail Company ID', placeholder: 'Your CallRail company ID', required: true },
      { key: 'apiKey', label: 'API Key', placeholder: 'CallRail API key for verification', type: 'password', required: true },
    ],
  },
]

const EVENT_OPTIONS = [
  { value: 'lead.created', label: 'New Lead' },
  { value: 'lead.qualified', label: 'Lead Qualified' },
  { value: 'consultation.scheduled', label: 'Consultation Booked' },
  { value: 'consultation.completed', label: 'Consultation Completed' },
  { value: 'consultation.no_show', label: 'No-Show' },
  { value: 'treatment.presented', label: 'Treatment Presented' },
  { value: 'treatment.accepted', label: 'Treatment Accepted' },
  { value: 'contract.signed', label: 'Contract Signed' },
  { value: 'treatment.completed', label: 'Treatment Completed' },
  { value: 'lead.lost', label: 'Lead Lost' },
  { value: 'payment.received', label: 'Payment Received' },
]

export default function ConnectorsPage() {
  const searchParams = useSearchParams()
  const oauthError = searchParams.get('oauth_error')
  const [connectors, setConnectors] = useState<ConnectorData[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedConnector, setExpandedConnector] = useState<ConnectorType | null>(null)
  const [formData, setFormData] = useState<Record<string, string>>({})
  const [selectedEvents, setSelectedEvents] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState<ConnectorType | null>(null)
  const [testResult, setTestResult] = useState<{ type: ConnectorType; success: boolean; message: string } | null>(null)

  const fetchConnectors = useCallback(async () => {
    try {
      const res = await fetch('/api/connectors')
      if (res.ok) {
        const data = await res.json()
        setConnectors(data.connectors || [])
      }
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchConnectors()
  }, [fetchConnectors])

  async function handleSave(info: ConnectorInfo) {
    setSaving(true)
    try {
      // Build credentials from form
      const credentials: Record<string, string | string[]> = {}
      for (const field of info.fields) {
        if (formData[field.key]) {
          credentials[field.key] = formData[field.key]
        }
      }

      // Add events if applicable (webhooks, slack)
      if (['outbound_webhook', 'slack'].includes(info.type) && selectedEvents.length > 0) {
        credentials.events = selectedEvents
      }

      const res = await fetch('/api/connectors', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connector_type: info.type,
          enabled: true,
          credentials,
          settings: {},
        }),
      })

      if (res.ok) {
        toast.success(`${info.name} connector saved and enabled`)
        setExpandedConnector(null)
        setFormData({})
        setSelectedEvents([])
        fetchConnectors()
      } else {
        const err = await res.json()
        toast.error(err.error || 'Failed to save connector')
      }
    } catch {
      toast.error('Failed to save connector')
    } finally {
      setSaving(false)
    }
  }

  async function handleToggle(connectorType: ConnectorType, enabled: boolean) {
    try {
      const connector = connectors.find((c) => c.connector_type === connectorType)
      if (!connector?.configured) return

      const res = await fetch('/api/connectors', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connector_type: connectorType,
          enabled,
          credentials: {},  // Don't overwrite credentials on toggle
          settings: {},
        }),
      })

      if (res.ok) {
        toast.success(enabled ? 'Connector enabled' : 'Connector paused')
        fetchConnectors()
      }
    } catch {
      toast.error('Failed to update connector')
    }
  }

  async function handleDelete(connectorType: ConnectorType, connectorName: string) {
    if (!confirm(`Remove ${connectorName}? This will stop sending events to this connector.`)) return

    try {
      const res = await fetch(`/api/connectors?type=${connectorType}`, {
        method: 'DELETE',
      })

      if (res.ok) {
        toast.success(`${connectorName} connector removed`)
        fetchConnectors()
      }
    } catch {
      toast.error('Failed to remove connector')
    }
  }

  function toggleEvent(event: string) {
    setSelectedEvents((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event]
    )
  }

  async function handleTestConnection(connectorType: ConnectorType, connectorName: string) {
    setTesting(connectorType)
    setTestResult(null)
    try {
      const res = await fetch('/api/connectors/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connector_type: connectorType }),
      })
      const data = await res.json()
      if (data.result?.success) {
        setTestResult({ type: connectorType, success: true, message: `${connectorName} is working!` })
        toast.success(`${connectorName} test passed ✓`)
      } else {
        setTestResult({ type: connectorType, success: false, message: data.result?.error || data.error || 'Test failed' })
        toast.error(`${connectorName} test failed: ${data.result?.error || 'Unknown error'}`)
      }
    } catch {
      setTestResult({ type: connectorType, success: false, message: 'Network error' })
      toast.error('Failed to test connector')
    } finally {
      setTesting(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <Link href="/settings" className="text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <Plug className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold">Marketing Connectors</h1>
        </div>
        <p className="text-muted-foreground ml-[52px]">
          Connect your ad platforms, analytics, and team tools for closed-loop ROI tracking
        </p>
      </div>

      {oauthError && (
        <Card className="mb-6 border-amber-500/40 bg-amber-500/5">
          <CardContent className="py-3 flex items-start gap-2 text-sm">
            <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">Connection didn&apos;t complete</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Error code: <code className="font-mono">{oauthError}</code>. Try reconnecting, or use the &quot;Configure manually&quot; button to enter credentials directly.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Quick Stats */}
      {connectors.some((c) => c.configured) && (
        <Card className="mb-6">
          <CardContent className="py-4">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-2xl font-bold">
                  {connectors.filter((c) => c.enabled).length}
                </p>
                <p className="text-xs text-muted-foreground">Active Connectors</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-green-600">
                  {connectors.reduce((s, c) => s + c.stats.sent, 0)}
                </p>
                <p className="text-xs text-muted-foreground">Events Sent (24h)</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-red-500">
                  {connectors.reduce((s, c) => s + c.stats.failed, 0)}
                </p>
                <p className="text-xs text-muted-foreground">Failures (24h)</p>
              </div>
            </div>
            <div className="text-center mt-3">
              <Link
                href="/settings/connectors/events"
                className="text-xs text-primary hover:underline flex items-center justify-center gap-1"
              >
                <Activity className="h-3 w-3" />
                View Event Log
              </Link>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Connector Cards */}
      <div className="space-y-4">
        {CONNECTOR_INFO.map((info) => {
          const data = connectors.find((c) => c.connector_type === info.type)
          const isExpanded = expandedConnector === info.type

          return (
            <Card key={info.type} className={data?.enabled ? 'border-primary/30' : ''}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg bg-muted ${info.color}`}>
                      <info.icon className="h-5 w-5" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <CardTitle className="text-base">{info.name}</CardTitle>
                        {data?.configured && (
                          <Badge
                            variant={data.enabled ? 'default' : 'secondary'}
                            className="text-[10px] px-1.5 h-4"
                          >
                            {data.enabled ? 'Active' : 'Paused'}
                          </Badge>
                        )}
                        {data?.stats && (data.stats.sent > 0 || data.stats.failed > 0) && (
                          <Badge variant="outline" className="text-[10px] px-1.5 h-4 gap-1">
                            <Activity className="h-2.5 w-2.5" />
                            {data.stats.sent} sent
                            {data.stats.failed > 0 && (
                              <span className="text-red-500">· {data.stats.failed} failed</span>
                            )}
                          </Badge>
                        )}
                        {data?.syncStatus && (
                          <SyncBadge sync={data.syncStatus} />
                        )}
                      </div>
                      <CardDescription className="text-xs mt-0.5">
                        {info.description}
                      </CardDescription>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {data?.configured && (
                      <>
                        <Switch
                          checked={data.enabled}
                          onCheckedChange={(checked: boolean) => handleToggle(info.type, checked)}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-red-500"
                          onClick={() => handleDelete(info.type, info.name)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    )}
                    {!data?.configured && (info.type === 'google_ads' || info.type === 'ga4') && !isExpanded && (
                      <Button
                        size="sm"
                        onClick={() => {
                          window.location.href = '/api/connectors/oauth/google/connect'
                        }}
                      >
                        Connect with Google
                      </Button>
                    )}
                    {!data?.configured && info.type === 'meta_capi' && !isExpanded && (
                      <Button
                        size="sm"
                        onClick={() => {
                          window.location.href = '/api/connectors/oauth/meta/connect'
                        }}
                      >
                        Connect with Meta
                      </Button>
                    )}
                    {!data?.configured && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setExpandedConnector(isExpanded ? null : info.type)
                          setFormData({})
                          setSelectedEvents([])
                        }}
                      >
                        {isExpanded
                          ? 'Cancel'
                          : (info.type === 'google_ads' || info.type === 'ga4' || info.type === 'meta_capi')
                            ? 'Configure manually'
                            : 'Configure'}
                      </Button>
                    )}
                    {data?.configured && !isExpanded && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs"
                          disabled={testing === info.type}
                          onClick={() => handleTestConnection(info.type, info.name)}
                        >
                          {testing === info.type ? (
                            <Loader2 className="h-3 w-3 animate-spin mr-1" />
                          ) : (
                            <Activity className="h-3 w-3 mr-1" />
                          )}
                          Test
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setExpandedConnector(isExpanded ? null : info.type)}
                        >
                          Edit
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </CardHeader>

              {/* Expanded Configuration Form */}
              {isExpanded && (
                <CardContent className="pt-0">
                  <Separator className="mb-4" />

                  <div className="space-y-4">
                    {info.fields.map((field) => (
                      <div key={field.key} className="space-y-1.5">
                        <Label className="text-sm">
                          {field.label}
                          {field.required && <span className="text-red-500 ml-0.5">*</span>}
                        </Label>
                        <Input
                          type={field.type || 'text'}
                          placeholder={field.placeholder}
                          value={formData[field.key] || ''}
                          onChange={(e) =>
                            setFormData((prev) => ({ ...prev, [field.key]: e.target.value }))
                          }
                          className="font-mono text-xs"
                        />
                      </div>
                    ))}

                    {/* Event Selection for webhooks and slack */}
                    {['outbound_webhook', 'slack'].includes(info.type) && (
                      <div className="space-y-2">
                        <Label className="text-sm">Events to Send</Label>
                        <div className="grid grid-cols-2 gap-2">
                          {EVENT_OPTIONS.map((ev) => (
                            <label
                              key={ev.value}
                              className="flex items-center gap-2 text-xs cursor-pointer hover:bg-muted p-1.5 rounded"
                            >
                              <input
                                type="checkbox"
                                checked={selectedEvents.includes(ev.value)}
                                onChange={() => toggleEvent(ev.value)}
                                className="rounded"
                              />
                              {ev.label}
                            </label>
                          ))}
                        </div>
                        {selectedEvents.length === 0 && (
                          <p className="text-[10px] text-amber-600 flex items-center gap-1">
                            <AlertTriangle className="h-3 w-3" />
                            No events selected — all events will be sent
                          </p>
                        )}
                      </div>
                    )}

                    <div className="flex items-center justify-between pt-2">
                      <div className="flex items-center gap-2">
                        {info.docsUrl && (
                          <a
                            href={info.docsUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                          >
                            <ExternalLink className="h-3 w-3" />
                            API Docs
                          </a>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setExpandedConnector(null)
                            setFormData({})
                          }}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => handleSave(info)}
                          disabled={saving || !info.fields.some(
                            (f) => f.required && !formData[f.key]
                          ) === false}
                        >
                          {saving ? (
                            <Loader2 className="h-3 w-3 animate-spin mr-1" />
                          ) : (
                            <Save className="h-3 w-3 mr-1" />
                          )}
                          Save & Enable
                        </Button>
                      </div>
                    </div>
                  </div>
                </CardContent>
              )}
            </Card>
          )
        })}
      </div>

      {/* How It Works */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-sm">How Connectors Work</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs text-muted-foreground">
            <div className="flex items-start gap-2">
              <div className="bg-primary text-primary-foreground rounded-full h-5 w-5 flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5">
                1
              </div>
              <div>
                <p className="font-medium text-foreground">CRM Event Fires</p>
                <p>When a lead is created or moves through your pipeline, an event is generated.</p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <div className="bg-primary text-primary-foreground rounded-full h-5 w-5 flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5">
                2
              </div>
              <div>
                <p className="font-medium text-foreground">Dispatcher Routes</p>
                <p>The event is sent to all your enabled connectors simultaneously, in the background.</p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <div className="bg-primary text-primary-foreground rounded-full h-5 w-5 flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5">
                3
              </div>
              <div>
                <p className="font-medium text-foreground">Platforms Optimize</p>
                <p>Google & Meta use your conversion data to find more patients like your best cases.</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * Surface the daily ad-metrics sync status next to push-side stats.
 * Shows three states:
 *   - never synced  → muted "Pull pending" badge
 *   - failed        → destructive badge with the error preview
 *   - succeeded     → outline badge with relative time + rows count
 */
function SyncBadge({
  sync,
}: {
  sync: {
    last_synced_at: string | null
    last_success_at: string | null
    last_error: string | null
    rows_inserted_last_run: number | null
  }
}) {
  if (!sync.last_synced_at) {
    return (
      <Badge variant="secondary" className="text-[10px] px-1.5 h-4 gap-1">
        <Clock className="h-2.5 w-2.5" />
        Pull pending
      </Badge>
    )
  }
  if (sync.last_error) {
    return (
      <Badge
        variant="destructive"
        className="text-[10px] px-1.5 h-4 gap-1"
        title={sync.last_error}
      >
        <AlertTriangle className="h-2.5 w-2.5" />
        Sync failed
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="text-[10px] px-1.5 h-4 gap-1">
      <Clock className="h-2.5 w-2.5" />
      Synced {formatRelativeTime(sync.last_synced_at)}
      {sync.rows_inserted_last_run != null && sync.rows_inserted_last_run > 0 && (
        <span className="text-muted-foreground">· {sync.rows_inserted_last_run} rows</span>
      )}
    </Badge>
  )
}

function formatRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
