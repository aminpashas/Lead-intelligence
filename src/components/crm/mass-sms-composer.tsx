'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
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
import { cn } from '@/lib/utils'

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

const TEMPLATE_VARS = [
  { var: '{{first_name}}', label: 'First Name' },
  { var: '{{last_name}}', label: 'Last Name' },
  { var: '{{full_name}}', label: 'Full Name' },
]

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

  useEffect(() => {
    fetchSmartLists()
  }, [])

  useEffect(() => {
    if (selectedListId) {
      fetchPreviewCount()
    } else {
      setPreviewCount(null)
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
  const canSend = selectedListId && message.trim().length > 0 && status === 'idle'

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
          <div className="inline-flex items-center justify-center h-16 w-16 rounded-full bg-green-100 dark:bg-green-950/30 mx-auto">
            <CheckCircle2 className="h-8 w-8 text-green-600" />
          </div>
          <div>
            <h2 className="text-xl font-bold">Broadcast Complete</h2>
            <p className="text-muted-foreground mt-1">
              {broadcastName || 'Mass SMS'}
            </p>
          </div>
          <div className="flex items-center justify-center gap-6">
            <div className="text-center">
              <p className="text-2xl font-bold text-green-600">{results.sent}</p>
              <p className="text-xs text-muted-foreground">Delivered</p>
            </div>
            {results.failed > 0 && (
              <div className="text-center">
                <p className="text-2xl font-bold text-red-500">{results.failed}</p>
                <p className="text-xs text-muted-foreground">Failed</p>
              </div>
            )}
            <div className="text-center">
              <p className="text-2xl font-bold">{results.total}</p>
              <p className="text-xs text-muted-foreground">Total</p>
            </div>
          </div>
          {selectedList && (
            <Badge variant="secondary" className="text-xs">
              <ListFilter className="h-3 w-3 mr-1" style={{ color: selectedList.color }} />
              {selectedList.name}
            </Badge>
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
            {onClose && (
              <Button onClick={onClose}>Done</Button>
            )}
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Send className="h-5 w-5 text-primary" />
          Mass SMS Broadcast
        </h2>
        <p className="text-sm text-muted-foreground">
          Send a personalized SMS to an entire Smart List at once
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Left: Compose */}
        <div className="lg:col-span-2 space-y-4">
          {/* Select Smart List */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-1.5">
                <ListFilter className="h-4 w-4" />
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
                      <Loader2 className="h-4 w-4 animate-spin" />
                    </div>
                  ) : smartLists.length === 0 ? (
                    <div className="p-3 text-sm text-muted-foreground text-center">
                      No Smart Lists yet. Create one first.
                    </div>
                  ) : (
                    smartLists.map((sl) => (
                      <SelectItem key={sl.id} value={sl.id}>
                        <span className="flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: sl.color }} />
                          {sl.name}
                          <span className="text-muted-foreground">({sl.lead_count} leads)</span>
                        </span>
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>

              {selectedList && (
                <div className="flex items-center gap-3 p-3 rounded-lg bg-accent/50">
                  <div
                    className="h-10 w-10 rounded-lg flex items-center justify-center"
                    style={{ backgroundColor: selectedList.color + '15' }}
                  >
                    <Users className="h-5 w-5" style={{ color: selectedList.color }} />
                  </div>
                  <div className="flex-1">
                    <p className="font-medium text-sm">{selectedList.name}</p>
                    <p className="text-xs text-muted-foreground">
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
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Compose Message */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-1.5">
                <MessageSquare className="h-4 w-4" />
                Compose Message
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Broadcast Name (optional)</Label>
                <Input
                  value={broadcastName}
                  onChange={(e) => setBroadcastName(e.target.value)}
                  placeholder="e.g. March Reactivation Blast"
                  className="h-8 text-sm"
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Message</Label>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">
                      {charCount}/1600
                    </Badge>
                    <Badge variant={segmentCount > 1 ? 'secondary' : 'outline'} className="text-[10px]">
                      {segmentCount} segment{segmentCount > 1 ? 's' : ''}
                    </Badge>
                  </div>
                </div>
                <Textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Hi {{first_name}}, ..."
                  rows={5}
                  maxLength={1600}
                />

                {/* Variable Buttons */}
                <div className="flex flex-wrap gap-1.5">
                  <span className="text-xs text-muted-foreground mt-1 mr-1">Insert:</span>
                  {TEMPLATE_VARS.map((v) => (
                    <Button
                      key={v.var}
                      variant="outline"
                      size="sm"
                      className="h-6 text-[10px] px-2"
                      onClick={() => insertVariable(v.var)}
                    >
                      {v.label}
                    </Button>
                  ))}
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
              <CardTitle className="text-sm flex items-center gap-1.5">
                <Sparkles className="h-4 w-4 text-amber-500" />
                Quick Templates
              </CardTitle>
              <CardDescription className="text-xs">
                Click to apply a pre-built message
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {TEMPLATES.map((t) => (
                <button
                  key={t.name}
                  onClick={() => applyTemplate(t)}
                  className="w-full text-left p-2.5 rounded-lg border hover:bg-accent/50 transition-colors"
                >
                  <p className="text-xs font-medium">{t.name}</p>
                  <p className="text-[10px] text-muted-foreground line-clamp-2 mt-0.5">
                    {t.body}
                  </p>
                </button>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-1.5">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                Best Practices
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1.5 text-[11px] text-muted-foreground">
                <li className="flex items-start gap-1.5">
                  <Clock className="h-3 w-3 mt-0.5 shrink-0" />
                  Send during business hours (9am-6pm local)
                </li>
                <li className="flex items-start gap-1.5">
                  <MessageSquare className="h-3 w-3 mt-0.5 shrink-0" />
                  Keep messages under 160 chars for 1 segment
                </li>
                <li className="flex items-start gap-1.5">
                  <Users className="h-3 w-3 mt-0.5 shrink-0" />
                  Use {"{{first_name}}"} for personalization
                </li>
                <li className="flex items-start gap-1.5">
                  <XCircle className="h-3 w-3 mt-0.5 shrink-0" />
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
            <DialogTitle className="flex items-center gap-2">
              <Send className="h-5 w-5 text-primary" />
              Confirm Broadcast
            </DialogTitle>
            <DialogDescription>
              This will send an SMS to all matching leads. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-3">
            {selectedList && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-accent/50">
                <ListFilter className="h-4 w-4" style={{ color: selectedList.color }} />
                <div>
                  <p className="text-sm font-medium">{selectedList.name}</p>
                  <p className="text-xs text-muted-foreground">
                    ~{previewCount ?? selectedList.lead_count} leads
                  </p>
                </div>
              </div>
            )}
            <div className="p-3 rounded-lg bg-muted/50 border">
              <p className="text-xs text-muted-foreground mb-1">Message preview:</p>
              <p className="text-sm whitespace-pre-wrap">
                {message.replace(/\{\{first_name\}\}/gi, 'John').replace(/\{\{last_name\}\}/gi, 'Smith').replace(/\{\{full_name\}\}/gi, 'John Smith')}
              </p>
            </div>
            <div className="flex items-center gap-2 p-2 rounded bg-amber-50 dark:bg-amber-950/20 text-amber-800 dark:text-amber-400 text-xs">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              Opted-out leads will be automatically skipped.
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button onClick={sendBroadcast} className="gap-1.5">
              <Send className="h-4 w-4" />
              Send to {previewCount ?? selectedList?.lead_count ?? 0} Leads
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
