'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Send, Users, ListFilter, MessageSquare, Loader2, CheckCircle2,
  AlertTriangle, Sparkles, Phone, XCircle, Clock,
} from 'lucide-react'
import { toast } from 'sonner'
import { A2P_PENDING_MESSAGE } from '@/lib/messaging/a2p-gate'
import { cn } from '@/lib/utils'
import { previewPersonalize } from '@/lib/campaigns/personalization'
import { VariablePicker } from './variable-picker'

interface SmartList {
  id: string
  name: string
  color: string
  lead_count: number
  criteria: Record<string, unknown>
}

interface MassSMSComposerProps {
  /** If provided, pre-selects this Smart List */
  initialSmartListId?: string
  onClose?: () => void
}

// Template vars are now in the shared VariablePicker component

const TEMPLATES = [
  {
    name: 'Follow-up Nudge',
    body: 'Hi {{first_name}}! We haven\'t heard from you in a while. We\'d love to help you get started on your smile transformation. Would you like to schedule a free consultation? Reply YES to get started!',
  },
  {
    name: 'Special Offer',
    body: 'Hi {{first_name}}! Great news — we\'re running a special promotion this month for dental implants. Limited spots available! Reply to learn more or call us to book your consult.',
  },
  {
    name: 'Appointment Reminder',
    body: 'Hi {{first_name}}, just a friendly reminder that we have availability this week for consultations. Would you like us to find a time that works for you?',
  },
  {
    name: 'Reactivation',
    body: 'Hi {{first_name}}, it\'s been a while since we last connected. We\'ve helped many patients just like you achieve their dream smile. If you\'re still interested, reply BOOK and we\'ll set up a free consult!',
  },
]

type BroadcastStatus = 'idle' | 'sending' | 'complete' | 'error'

export function MassSMSComposer({ initialSmartListId, onClose }: MassSMSComposerProps) {
  const [smartLists, setSmartLists] = useState<SmartList[]>([])
  const [selectedListId, setSelectedListId] = useState(initialSmartListId || '')
  const [message, setMessage] = useState('')
  const [broadcastName, setBroadcastName] = useState('')
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<BroadcastStatus>('idle')
  const [results, setResults] = useState<{
    total: number
    sent: number
    failed: number
    campaign_id?: string
  } | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [previewCount, setPreviewCount] = useState<number | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [usSmsBlocked, setUsSmsBlocked] = useState(false)
  const [eligibility, setEligibility] = useState<null | {
    sms: { total: number; eligible: number; no_consent: number; opted_out: number; no_contact: number }
    list_total: number
    capped: boolean
  }>(null)

  useEffect(() => {
    fetchSmartLists()
    fetchFlags()
  }, [])

  useEffect(() => {
    if (selectedListId) {
      fetchPreviewCount()
      fetchEligibility()
    } else {
      setPreviewCount(null)
      setEligibility(null)
    }
  }, [selectedListId])

  async function fetchSmartLists() {
    try {
      const res = await fetch('/api/smart-lists')
      if (res.ok) {
        const data = await res.json()
        setSmartLists(data.smart_lists || [])
      }
    } finally {
      setLoading(false)
    }
  }

  // Best-effort UI gate; the /api/sms/mass route is the authoritative A2P block.
  async function fetchFlags() {
    try {
      const res = await fetch('/api/org/flags')
      if (res.ok) {
        const { flags } = await res.json()
        setUsSmsBlocked(flags?.us_sms_enabled !== true)
      }
    } catch {
      /* leave banner hidden on error — the server still hard-blocks the send */
    }
  }

  async function fetchPreviewCount() {
    if (!selectedListId) return
    setPreviewLoading(true)
    try {
      const res = await fetch(`/api/smart-lists/${selectedListId}/leads?page=1&per_page=1`)
      if (res.ok) {
        const data = await res.json()
        setPreviewCount(data.total || 0)
      }
    } finally {
      setPreviewLoading(false)
    }
  }

  // Consent/eligibility breakdown — how many recipients are actually reachable by SMS.
  async function fetchEligibility() {
    if (!selectedListId) return
    try {
      const res = await fetch(`/api/smart-lists/${selectedListId}/eligibility`)
      if (res.ok) setEligibility(await res.json())
    } catch {
      /* non-fatal — the plain count still shows */
    }
  }

  function insertVariable(v: string) {
    setMessage((prev) => prev + v)
  }

  function applyTemplate(template: typeof TEMPLATES[0]) {
    setMessage(template.body)
    if (!broadcastName) {
      setBroadcastName(template.name)
    }
  }

  const selectedList = smartLists.find((l) => l.id === selectedListId)
  const charCount = message.length
  const segmentCount = Math.ceil(charCount / 160) || 1
  const canSend = !usSmsBlocked && selectedListId && message.trim().length > 0 && status === 'idle'

  function handleSendClick() {
    if (!canSend) return
    setConfirmOpen(true)
  }

  async function sendBroadcast() {
    setConfirmOpen(false)
    setStatus('sending')

    try {
      const res = await fetch('/api/sms/mass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          smart_list_id: selectedListId,
          message_template: message,
          broadcast_name: broadcastName || undefined,
        }),
      })

      if (res.ok) {
        const data = await res.json()
        setResults(data)
        setStatus('complete')
        toast.success(`Broadcast sent: ${data.sent}/${data.total} delivered`)
      } else {
        const err = await res.json()
        toast.error(err.error || 'Broadcast failed')
        setStatus('error')
      }
    } catch {
      toast.error('Network error — broadcast may have partially sent')
      setStatus('error')
    }
  }

  if (status === 'complete' && results) {
    return (
      <Card>
        <CardContent className="py-10 text-center space-y-4">
          <div className="inline-flex items-center justify-center h-16 w-16 rounded-full bg-aurea-primary/10 mx-auto">
            <CheckCircle2 className="h-8 w-8 text-aurea-primary" strokeWidth={1.75} />
          </div>
          <div>
            <h2 className="aurea-display text-[22px] text-aurea-ink">Broadcast Complete</h2>
            <p className="text-aurea-ink-3 mt-1 text-[13px]">
              {broadcastName || 'Mass SMS'}
            </p>
          </div>
          <div className="flex items-center justify-center gap-6">
            <div className="text-center">
              <p className="aurea-display text-[28px] tabular-nums text-aurea-primary">{results.sent}</p>
              <p className="text-[11px] text-aurea-ink-3">Delivered</p>
            </div>
            {results.failed > 0 && (
              <div className="text-center">
                <p className="aurea-display text-[28px] tabular-nums text-aurea-rose">{results.failed}</p>
                <p className="text-[11px] text-aurea-ink-3">Failed</p>
              </div>
            )}
            <div className="text-center">
              <p className="aurea-display text-[28px] tabular-nums text-aurea-ink">{results.total}</p>
              <p className="text-[11px] text-aurea-ink-3">Total</p>
            </div>
          </div>
          {selectedList && (
            <span className="inline-flex items-center gap-1.5 rounded border border-aurea-border bg-aurea-surface-2 px-2 py-1 text-[11px] text-aurea-ink-2">
              <ListFilter className="h-3 w-3 text-aurea-ink-3" strokeWidth={1.75} />
              {selectedList.name}
            </span>
          )}
          <div className="flex gap-2 justify-center pt-2">
            <Button
              variant="outline"
              onClick={() => {
                setStatus('idle')
                setResults(null)
                setMessage('')
                setBroadcastName('')
              }}
            >
              Send Another
            </Button>
            <Button variant="outline" onClick={() => window.location.href = '/campaigns/broadcasts/audit'}>
              View Audit Log
            </Button>
            {onClose && (
              <Button onClick={onClose}>Done</Button>
            )}
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="animate-in fade-in-0 duration-500 space-y-4">
      {/* Header */}
      <div>
        <p className="aurea-eyebrow mb-2">Outreach</p>
        <h2 className="aurea-display text-[28px] text-aurea-ink">Mass SMS Broadcast</h2>
        <p className="mt-1 text-[13px] text-aurea-ink-2">
          Send a personalized SMS to an entire Smart List at once
        </p>
      </div>

      {usSmsBlocked && (
        <div className="flex items-start gap-2.5 rounded-lg border border-aurea-amber/40 bg-aurea-amber/10 px-3.5 py-3 text-[13px] text-aurea-ink-2">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-aurea-amber" strokeWidth={1.75} />
          <span>{A2P_PENDING_MESSAGE}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Left: Compose */}
        <div className="lg:col-span-2 space-y-4">
          {/* Select Smart List */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-1.5 text-aurea-ink">
                <ListFilter className="h-[17px] w-[17px] text-aurea-ink-3" strokeWidth={1.75} />
                Target Audience
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Select value={selectedListId} onValueChange={(v) => setSelectedListId(v || '')}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a Smart List..." />
                </SelectTrigger>
                <SelectContent>
                  {loading ? (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 className="h-4 w-4 animate-spin text-aurea-ink-3" />
                    </div>
                  ) : smartLists.length === 0 ? (
                    <div className="p-3 text-sm text-aurea-ink-3 text-center">
                      No Smart Lists yet. Create one first.
                    </div>
                  ) : (
                    smartLists.map((sl) => (
                      <SelectItem key={sl.id} value={sl.id}>
                        <span className="flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: sl.color }} />
                          {sl.name}
                          <span className="text-aurea-ink-3">({sl.lead_count} leads)</span>
                        </span>
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>

              {selectedList && (
                <div className="flex items-center gap-3 p-3 rounded-lg bg-aurea-surface-2 border border-aurea-border">
                  <div
                    className="h-10 w-10 rounded-lg flex items-center justify-center bg-aurea-surface-2 border border-aurea-border"
                  >
                    <Users className="h-[18px] w-[18px] text-aurea-ink-2" strokeWidth={1.75} />
                  </div>
                  <div className="flex-1">
                    <p className="font-medium text-[13px] text-aurea-ink">{selectedList.name}</p>
                    <p className="text-[11px] text-aurea-ink-3">
                      {previewLoading ? (
                        <span className="flex items-center gap-1">
                          <Loader2 className="h-3 w-3 animate-spin" /> Counting leads...
                        </span>
                      ) : (
                        <>
                          <Phone className="h-3 w-3 inline mr-0.5" />
                          {previewCount !== null ? `${previewCount} leads with phone numbers` : `${selectedList.lead_count} leads`}
                        </>
                      )}
                    </p>
                    {eligibility && (
                      <p className="mt-0.5 text-[11px] text-aurea-ink-3">
                        <span className="font-medium text-aurea-primary">
                          {eligibility.sms.eligible.toLocaleString()} SMS-eligible
                        </span>
                        {eligibility.sms.total > eligibility.sms.eligible && (
                          <>
                            {' · '}
                            {(eligibility.sms.total - eligibility.sms.eligible).toLocaleString()} excluded
                            {' ('}
                            {[
                              eligibility.sms.no_consent > 0 ? `${eligibility.sms.no_consent} no consent` : null,
                              eligibility.sms.opted_out > 0 ? `${eligibility.sms.opted_out} opted out` : null,
                              eligibility.sms.no_contact > 0 ? `${eligibility.sms.no_contact} no phone` : null,
                            ].filter(Boolean).join(', ')}
                            {')'}
                          </>
                        )}
                        {eligibility.capped && <>{' · '}sampled from {eligibility.list_total.toLocaleString()}</>}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Compose Message */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-1.5 text-aurea-ink">
                <MessageSquare className="h-[17px] w-[17px] text-aurea-ink-3" strokeWidth={1.75} />
                Compose Message
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <Label className="text-[11px] text-aurea-ink-3">Broadcast Name (optional)</Label>
                <Input
                  value={broadcastName}
                  onChange={(e) => setBroadcastName(e.target.value)}
                  placeholder="e.g. March Reactivation Blast"
                  className="h-8 text-sm"
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-[13px] text-aurea-ink">Message</Label>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] tabular-nums text-aurea-ink-3 border border-aurea-border rounded px-1.5 py-0.5">
                      {charCount}/1600
                    </span>
                    <span className={cn(
                      'font-mono text-[10px] tabular-nums rounded px-1.5 py-0.5 border',
                      segmentCount > 1
                        ? 'text-aurea-amber border-aurea-amber/30 bg-aurea-amber/10'
                        : 'text-aurea-ink-3 border-aurea-border'
                    )}>
                      {segmentCount} segment{segmentCount > 1 ? 's' : ''}
                    </span>
                  </div>
                </div>
                <Textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Hi {{first_name}}, ..."
                  rows={5}
                  maxLength={1600}
                />

                {/* Variable Picker */}
                <div className="flex items-center gap-2">
                  <VariablePicker onInsert={insertVariable} label="Insert Variable" />
                  <span className="text-[10px] text-aurea-ink-3">20+ personalization fields available</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Send */}
          <div className="flex items-center gap-3">
            <Button
              className="gap-1.5"
              disabled={!canSend}
              onClick={handleSendClick}
            >
              {status === 'sending' ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <Send className="h-4 w-4" />
                  Send Broadcast
                </>
              )}
            </Button>
            {selectedList && (
              <p className="text-xs text-muted-foreground">
                Will send to ~{previewCount ?? selectedList.lead_count} leads
              </p>
            )}
          </div>
        </div>

        {/* Right: Templates */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-1.5 text-aurea-ink">
                <Sparkles className="h-[17px] w-[17px] text-aurea-amber" strokeWidth={1.75} />
                Quick Templates
              </CardTitle>
              <CardDescription className="text-[11px] text-aurea-ink-3">
                Click to apply a pre-built message
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {TEMPLATES.map((t) => (
                <button
                  key={t.name}
                  onClick={() => applyTemplate(t)}
                  className="w-full text-left p-2.5 rounded-lg border border-aurea-border hover:bg-aurea-surface-2 transition-colors"
                >
                  <p className="text-[12px] font-medium text-aurea-ink">{t.name}</p>
                  <p className="text-[10px] text-aurea-ink-3 line-clamp-2 mt-0.5">
                    {t.body}
                  </p>
                </button>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-1.5 text-aurea-ink">
                <AlertTriangle className="h-[17px] w-[17px] text-aurea-amber" strokeWidth={1.75} />
                Best Practices
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1.5 text-[11px] text-aurea-ink-3">
                <li className="flex items-start gap-1.5">
                  <Clock className="h-3 w-3 mt-0.5 shrink-0" strokeWidth={1.75} />
                  Send during business hours (9am-6pm local)
                </li>
                <li className="flex items-start gap-1.5">
                  <MessageSquare className="h-3 w-3 mt-0.5 shrink-0" strokeWidth={1.75} />
                  Keep messages under 160 chars for 1 segment
                </li>
                <li className="flex items-start gap-1.5">
                  <Users className="h-3 w-3 mt-0.5 shrink-0" strokeWidth={1.75} />
                  Use {"{{first_name}}"} for personalization
                </li>
                <li className="flex items-start gap-1.5">
                  <XCircle className="h-3 w-3 mt-0.5 shrink-0" strokeWidth={1.75} />
                  Opted-out leads are automatically excluded
                </li>
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Confirmation Dialog */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-aurea-ink">
              <Send className="h-[17px] w-[17px] text-aurea-primary" strokeWidth={1.75} />
              Confirm Broadcast
            </DialogTitle>
            <DialogDescription className="text-aurea-ink-3">
              This will send an SMS to all matching leads. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-3">
            {selectedList && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-aurea-surface-2 border border-aurea-border">
                <ListFilter className="h-[17px] w-[17px] text-aurea-ink-3" strokeWidth={1.75} />
                <div>
                  <p className="text-[13px] font-medium text-aurea-ink">{selectedList.name}</p>
                  <p className="text-[11px] text-aurea-ink-3 font-mono tabular-nums">
                    ~{previewCount ?? selectedList.lead_count} leads
                  </p>
                </div>
              </div>
            )}
            <div className="p-3 rounded-lg bg-aurea-surface-2 border border-aurea-border">
              <p className="text-[11px] text-aurea-ink-3 mb-1">Message preview:</p>
              <p className="text-[13px] text-aurea-ink whitespace-pre-wrap">
                {previewPersonalize(message)}
              </p>
            </div>
            <div className="flex items-center gap-2 p-2 rounded-lg bg-aurea-amber/10 border border-aurea-amber/20 text-aurea-amber text-[11px]">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
              Opted-out leads will be automatically skipped.
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button onClick={sendBroadcast} className="gap-1.5">
              <Send className="h-4 w-4" strokeWidth={1.75} />
              Send to {previewCount ?? selectedList?.lead_count ?? 0} Leads
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
