'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  Send, Mail, CheckCircle2, XCircle, Clock, Users,
  ChevronDown, ChevronRight, Loader2, ExternalLink,
  BarChart3, AlertTriangle, ArrowLeft,
} from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { cn } from '@/lib/utils'

interface DeliveryLogEntry {
  lead_id: string
  lead_name: string
  phone?: string
  email?: string
  status: 'sent' | 'failed' | 'skipped'
  error?: string
  sent_at?: string
  message_preview?: string
  subject?: string
}

interface BroadcastCampaign {
  id: string
  name: string
  type: string
  channel: string
  status: string
  total_enrolled: number
  total_completed: number
  created_at: string
  smart_list_id: string | null
  metadata: {
    delivery_log?: DeliveryLogEntry[]
    message_template?: string
    subject_template?: string
    body_template?: string
    broadcast_name?: string
  }
  smart_lists?: { name: string; color: string } | null
}

export function BroadcastAudit() {
  const [campaigns, setCampaigns] = useState<BroadcastCampaign[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedCampaign, setSelectedCampaign] = useState<BroadcastCampaign | null>(null)
  const [statusFilter, setStatusFilter] = useState<'all' | 'sent' | 'failed'>('all')

  useEffect(() => {
    fetchBroadcasts()
  }, [])

  async function fetchBroadcasts() {
    try {
      const res = await fetch('/api/campaigns')
      if (res.ok) {
        const data = await res.json()
        // Filter to broadcast campaigns only
        const broadcasts = (data.campaigns || []).filter(
          (c: BroadcastCampaign) => c.type === 'broadcast'
        )
        setCampaigns(broadcasts)
      }
    } finally {
      setLoading(false)
    }
  }

  const filteredLog = selectedCampaign?.metadata?.delivery_log?.filter((entry) => {
    if (statusFilter === 'all') return true
    return entry.status === statusFilter
  }) || []

  const selectedStats = selectedCampaign?.metadata?.delivery_log
    ? {
        total: selectedCampaign.metadata.delivery_log.length,
        sent: selectedCampaign.metadata.delivery_log.filter((e) => e.status === 'sent').length,
        failed: selectedCampaign.metadata.delivery_log.filter((e) => e.status === 'failed').length,
        skipped: selectedCampaign.metadata.delivery_log.filter((e) => e.status === 'skipped').length,
      }
    : null

  // Detail view
  if (selectedCampaign) {
    return (
      <div className="space-y-4 animate-in fade-in-0 duration-500">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => setSelectedCampaign(null)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex-1">
            <h2 className="aurea-display text-[28px] text-aurea-ink flex items-center gap-2">
              {selectedCampaign.channel === 'sms' ? (
                <Send className="h-5 w-5 text-aurea-ink-3" strokeWidth={1.75} />
              ) : (
                <Mail className="h-5 w-5 text-aurea-ink-2" strokeWidth={1.75} />
              )}
              {selectedCampaign.name}
            </h2>
            <p className="text-xs text-aurea-ink-2">
              {formatDistanceToNow(new Date(selectedCampaign.created_at), { addSuffix: true })}
              {selectedCampaign.smart_lists && (
                <> · Smart List: <span className="font-medium">{selectedCampaign.smart_lists.name}</span></>
              )}
            </p>
          </div>
        </div>

        {/* Stats Row */}
        {selectedStats && (
          <div className="grid grid-cols-4 gap-3">
            <Card>
              <CardContent className="pt-4 text-center">
                <p className="aurea-display text-[32px] tabular-nums text-aurea-ink">{selectedStats.total}</p>
                <p className="aurea-eyebrow">Total Targets</p>
              </CardContent>
            </Card>
            <Card className="border-aurea-border-strong">
              <CardContent className="pt-4 text-center">
                <p className="aurea-display text-[32px] tabular-nums text-aurea-primary">{selectedStats.sent}</p>
                <p className="aurea-eyebrow">Delivered</p>
              </CardContent>
            </Card>
            <Card className="border-aurea-rose/20">
              <CardContent className="pt-4 text-center">
                <p className="aurea-display text-[32px] tabular-nums text-aurea-rose">{selectedStats.failed}</p>
                <p className="aurea-eyebrow">Failed</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 text-center">
                <p className="aurea-display text-[32px] tabular-nums text-aurea-primary">
                  {selectedStats.total > 0 ? Math.round((selectedStats.sent / selectedStats.total) * 100) : 0}%
                </p>
                <p className="aurea-eyebrow">Success Rate</p>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Template used */}
        {(selectedCampaign.metadata?.message_template || selectedCampaign.metadata?.subject_template) && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="aurea-display text-[18px]">Message Template Used</CardTitle>
            </CardHeader>
            <CardContent>
              {selectedCampaign.metadata.subject_template && (
                <div className="mb-2">
                  <p className="text-xs text-muted-foreground">Subject:</p>
                  <p className="text-sm font-medium">{selectedCampaign.metadata.subject_template}</p>
                </div>
              )}
              <div className="p-3 rounded bg-muted/50 text-sm whitespace-pre-wrap font-mono max-h-40 overflow-y-auto">
                {selectedCampaign.metadata.message_template || selectedCampaign.metadata.body_template}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Delivery Log Filter */}
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">Delivery Log</p>
          <div className="flex gap-1 ml-auto">
            {(['all', 'sent', 'failed'] as const).map((f) => (
              <Button
                key={f}
                variant={statusFilter === f ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 text-xs capitalize"
                onClick={() => setStatusFilter(f)}
              >
                {f === 'all' ? `All (${selectedStats?.total || 0})` :
                 f === 'sent' ? `Delivered (${selectedStats?.sent || 0})` :
                 `Failed (${selectedStats?.failed || 0})`}
              </Button>
            ))}
          </div>
        </div>

        {/* Delivery Table */}
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Lead</TableHead>
                  <TableHead>{selectedCampaign.channel === 'sms' ? 'Phone' : 'Email'}</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>{selectedCampaign.channel === 'sms' ? 'Preview' : 'Subject'}</TableHead>
                  <TableHead>Sent At</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredLog.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                      No delivery records found
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredLog.map((entry, i) => (
                    <TableRow key={`${entry.lead_id}-${i}`}>
                      <TableCell>
                        <p className="text-sm font-medium">{entry.lead_name}</p>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-muted-foreground font-mono">
                          {entry.phone || entry.email || '—'}
                        </span>
                      </TableCell>
                      <TableCell>
                        {entry.status === 'sent' ? (
                          <Badge className="bg-aurea-primary/10 text-aurea-primary text-xs gap-1">
                            <CheckCircle2 className="h-3 w-3" /> Delivered
                          </Badge>
                        ) : entry.status === 'failed' ? (
                          <span>
                            <Badge className="bg-aurea-rose/10 text-aurea-rose text-xs gap-1">
                              <XCircle className="h-3 w-3" /> Failed
                            </Badge>
                            {entry.error && (
                              <p className="text-[10px] text-aurea-rose mt-0.5 max-w-48 truncate">
                                {entry.error}
                              </p>
                            )}
                          </span>
                        ) : (
                          <Badge variant="secondary" className="text-xs gap-1">
                            <Clock className="h-3 w-3" /> Skipped
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <p className="text-xs text-muted-foreground max-w-48 truncate">
                          {entry.message_preview || entry.subject || '—'}
                        </p>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-muted-foreground">
                          {entry.sent_at
                            ? formatDistanceToNow(new Date(entry.sent_at), { addSuffix: true })
                            : '—'}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    )
  }

  // List view
  return (
    <div className="space-y-4 animate-in fade-in-0 duration-500">
      <div>
        <p className="aurea-eyebrow mb-1">Campaigns</p>
        <h2 className="aurea-display text-[28px] text-aurea-ink flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-aurea-ink-3" strokeWidth={1.75} />
          Broadcast Audit Log
        </h2>
        <p className="text-sm text-aurea-ink-2">
          Track delivery status of all mass SMS and email broadcasts
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : campaigns.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-16">
            <Send className="h-10 w-10 text-muted-foreground mb-3" />
            <p className="font-medium">No broadcasts yet</p>
            <p className="text-sm text-muted-foreground">
              Send a Mass SMS or Email to see delivery reports here
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {campaigns.map((c) => {
            const log = c.metadata?.delivery_log || []
            const sentCount = log.filter((e) => e.status === 'sent').length
            const failedCount = log.filter((e) => e.status === 'failed').length
            const total = log.length || c.total_enrolled || 0
            const successRate = total > 0 ? Math.round((sentCount / total) * 100) : 0

            return (
              <Card
                key={c.id}
                className="cursor-pointer hover:bg-aurea-surface-2 transition-colors"
                onClick={() => setSelectedCampaign(c)}
              >
                <CardContent className="flex items-center gap-4 py-3">
                  <div className="h-10 w-10 rounded-lg flex items-center justify-center shrink-0 bg-aurea-surface-2">
                    {c.channel === 'sms' ? (
                      <Send className="h-5 w-5 text-aurea-ink-2" />
                    ) : (
                      <Mail className="h-5 w-5 text-aurea-ink-2" />
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-sm truncate">{c.name}</p>
                      <Badge variant="outline" className="text-[10px] capitalize shrink-0">
                        {c.channel}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(c.created_at), { addSuffix: true })}
                      {c.smart_lists && (
                        <> · {c.smart_lists.name}</>
                      )}
                    </p>
                  </div>

                  <div className="flex items-center gap-4 shrink-0">
                    <div className="text-center">
                      <p className="text-sm font-bold text-aurea-primary">{sentCount}</p>
                      <p className="text-[10px] text-muted-foreground">Sent</p>
                    </div>
                    {failedCount > 0 && (
                      <div className="text-center">
                        <p className="text-sm font-bold text-aurea-rose">{failedCount}</p>
                        <p className="text-[10px] text-muted-foreground">Failed</p>
                      </div>
                    )}
                    <div className="text-center">
                      <p className={cn(
                        'text-sm font-bold',
                        successRate >= 90 ? 'text-aurea-primary' : successRate >= 70 ? 'text-aurea-amber' : 'text-aurea-rose'
                      )}>
                        {successRate}%
                      </p>
                      <p className="text-[10px] text-muted-foreground">Rate</p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
