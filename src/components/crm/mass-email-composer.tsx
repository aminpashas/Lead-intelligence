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
  Mail, Users, ListFilter, Loader2, CheckCircle2,
  AlertTriangle, Sparkles, AtSign, XCircle, Clock,
  Eye, Send,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { previewPersonalize } from '@/lib/campaigns/personalization'
import { VariablePicker } from './variable-picker'

interface SmartList {
  id: string
  name: string
  color: string
  lead_count: number
}

interface MassEmailComposerProps {
  initialSmartListId?: string
  onClose?: () => void
}

// Template vars are now in the shared VariablePicker component

const EMAIL_TEMPLATES = [
  {
    name: 'Consultation Invite',
    subject: '{{first_name}}, Your Free Smile Consultation Awaits',
    body: `Hi {{first_name}},

I wanted to personally reach out because we noticed you expressed interest in transforming your smile with dental implants.

We're currently offering complimentary consultations where our specialists will:
• Evaluate your specific needs
• Walk you through the All-on-4 procedure
• Provide a personalized treatment plan
• Discuss flexible financing options

Spots fill up quickly — would you like us to reserve one for you?

Simply reply to this email or call us to get started.

Looking forward to helping you smile with confidence!`,
  },
  {
    name: 'Special Promotion',
    subject: 'Limited Time Offer for {{first_name}} — Dental Implant Savings',
    body: `Hi {{first_name}},

Great news! We're running an exclusive promotion this month on dental implant procedures.

For a limited time, you can take advantage of:
✅ Complimentary 3D CT Scan (valued at $300)
✅ Special financing with 0% APR for qualified patients
✅ Free second opinion if you've been quoted elsewhere

This offer is only available for a limited time and spots are limited.

Reply to this email or call us to learn more about how we can help you achieve the smile you've always wanted.

Best regards`,
  },
  {
    name: 'Follow-Up',
    subject: 'Still Thinking About Your Smile, {{first_name}}?',
    body: `Hi {{first_name}},

I hope this email finds you well! I'm following up on your recent inquiry about dental implants.

I understand that making a decision about your dental health is important, and I'm here to answer any questions you might have.

Whether you're curious about:
• The procedure itself
• Recovery time
• Cost and financing
• Before & after results

I'm happy to help. Feel free to reply to this email or give us a call.

We're here when you're ready!`,
  },
  {
    name: 'Reactivation',
    subject: '{{first_name}}, We Miss You! Let\'s Reconnect',
    body: `Hi {{first_name}},

It's been a while since we last connected, and I wanted to check in to see how you're doing.

Since your last visit, we've introduced several improvements:
• New advanced implant technology for faster healing
• Expanded financing options
• Enhanced patient comfort protocols

If you're still considering dental implants, we'd love to schedule a quick call to discuss how things have evolved.

No pressure at all — just reply "interested" and I'll have our coordinator reach out at a convenient time.

Warm regards`,
  },
]

type BroadcastStatus = 'idle' | 'sending' | 'complete' | 'error'

export function MassEmailComposer({ initialSmartListId, onClose }: MassEmailComposerProps) {
  const [smartLists, setSmartLists] = useState<SmartList[]>([])
  const [selectedListId, setSelectedListId] = useState(initialSmartListId || '')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [broadcastName, setBroadcastName] = useState('')
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<BroadcastStatus>('idle')
  const [results, setResults] = useState<{
    total: number; sent: number; failed: number; campaign_id?: string
  } | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewCount, setPreviewCount] = useState<number | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [activeField, setActiveField] = useState<'subject' | 'body'>('body')

  useEffect(() => { fetchSmartLists() }, [])

  useEffect(() => {
    if (selectedListId) fetchPreviewCount()
    else setPreviewCount(null)
  }, [selectedListId])

  async function fetchSmartLists() {
    try {
      const res = await fetch('/api/smart-lists')
      if (res.ok) {
        const data = await res.json()
        setSmartLists(data.smart_lists || [])
      }
    } finally { setLoading(false) }
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
    } finally { setPreviewLoading(false) }
  }

  function insertVariable(v: string) {
    if (activeField === 'subject') {
      setSubject((prev) => prev + v)
    } else {
      setBody((prev) => prev + v)
    }
  }

  function applyTemplate(template: typeof EMAIL_TEMPLATES[0]) {
    setSubject(template.subject)
    setBody(template.body)
    if (!broadcastName) setBroadcastName(template.name)
  }

  // previewPersonalize is now imported from shared engine

  const selectedList = smartLists.find((l) => l.id === selectedListId)
  const canSend = selectedListId && subject.trim().length > 0 && body.trim().length > 0 && status === 'idle'

  async function sendBroadcast() {
    setConfirmOpen(false)
    setStatus('sending')

    try {
      const res = await fetch('/api/email/mass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          smart_list_id: selectedListId,
          subject_template: subject,
          body_template: body,
          broadcast_name: broadcastName || undefined,
        }),
      })

      if (res.ok) {
        const data = await res.json()
        setResults(data)
        setStatus('complete')
        toast.success(`Email broadcast sent: ${data.sent}/${data.total} delivered`)
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

  // Complete state
  if (status === 'complete' && results) {
    return (
      <Card>
        <CardContent className="py-10 text-center space-y-4">
          <div className="inline-flex items-center justify-center h-16 w-16 rounded-full bg-green-100 dark:bg-green-950/30 mx-auto">
            <CheckCircle2 className="h-8 w-8 text-green-600" />
          </div>
          <div>
            <h2 className="text-xl font-bold">Email Broadcast Complete</h2>
            <p className="text-muted-foreground mt-1">{broadcastName || 'Mass Email'}</p>
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
            <Button variant="outline" onClick={() => {
              setStatus('idle'); setResults(null); setSubject(''); setBody(''); setBroadcastName('')
            }}>Send Another</Button>
            <Button variant="outline" onClick={() => window.location.href = '/broadcast-audit'}>
              View Audit Log
            </Button>
            {onClose && <Button onClick={onClose}>Done</Button>}
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
          <Mail className="h-5 w-5 text-primary" />
          Mass Email Broadcast
        </h2>
        <p className="text-sm text-muted-foreground">
          Send a personalized email to an entire Smart List at once
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Left: Compose */}
        <div className="lg:col-span-2 space-y-4">
          {/* Select Smart List */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-1.5">
                <ListFilter className="h-4 w-4" /> Target Audience
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
                  <div className="h-10 w-10 rounded-lg flex items-center justify-center"
                    style={{ backgroundColor: selectedList.color + '15' }}>
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
                        <><AtSign className="h-3 w-3 inline mr-0.5" />
                          {previewCount !== null ? `${previewCount} leads with email` : `${selectedList.lead_count} leads`}</>
                      )}
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Compose Email */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-1.5">
                <Mail className="h-4 w-4" /> Compose Email
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Broadcast Name (optional)</Label>
                <Input
                  value={broadcastName}
                  onChange={(e) => setBroadcastName(e.target.value)}
                  placeholder="e.g. March Reactivation Email"
                  className="h-8 text-sm"
                />
              </div>

              <div className="space-y-2">
                <Label>Subject Line</Label>
                <Input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  onFocus={() => setActiveField('subject')}
                  placeholder="Your Free Consultation Awaits, {{first_name}}"
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Email Body</Label>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs gap-1"
                    onClick={() => setPreviewOpen(true)}
                    disabled={!body}
                  >
                    <Eye className="h-3 w-3" /> Preview
                  </Button>
                </div>
                <Textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  onFocus={() => setActiveField('body')}
                  placeholder="Hi {{first_name}},\n\nWe wanted to reach out about..."
                  rows={10}
                  className="font-mono text-sm"
                />
              </div>

              {/* Variable Picker */}
              <div className="flex items-center gap-2">
                <VariablePicker
                  onInsert={insertVariable}
                  label={`Insert into ${activeField}`}
                />
                <span className="text-[10px] text-muted-foreground">20+ personalization fields</span>
              </div>
            </CardContent>
          </Card>

          {/* Send */}
          <div className="flex items-center gap-3">
            <Button className="gap-1.5" disabled={!canSend} onClick={() => setConfirmOpen(true)}>
              {status === 'sending' ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> Sending...</>
              ) : (
                <><Send className="h-4 w-4" /> Send Email Broadcast</>
              )}
            </Button>
            {selectedList && (
              <p className="text-xs text-muted-foreground">
                Will email ~{previewCount ?? selectedList.lead_count} leads
              </p>
            )}
          </div>
        </div>

        {/* Right: Templates + Tips */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-1.5">
                <Sparkles className="h-4 w-4 text-amber-500" /> Email Templates
              </CardTitle>
              <CardDescription className="text-xs">Click to apply</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {EMAIL_TEMPLATES.map((t) => (
                <button
                  key={t.name}
                  onClick={() => applyTemplate(t)}
                  className="w-full text-left p-2.5 rounded-lg border hover:bg-accent/50 transition-colors"
                >
                  <p className="text-xs font-medium">{t.name}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{t.subject}</p>
                </button>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-1.5">
                <AlertTriangle className="h-4 w-4 text-amber-500" /> Best Practices
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1.5 text-[11px] text-muted-foreground">
                <li className="flex items-start gap-1.5">
                  <Clock className="h-3 w-3 mt-0.5 shrink-0" />
                  Tue-Thu mornings get the best open rates
                </li>
                <li className="flex items-start gap-1.5">
                  <Mail className="h-3 w-3 mt-0.5 shrink-0" />
                  Keep subject lines under 50 characters
                </li>
                <li className="flex items-start gap-1.5">
                  <Users className="h-3 w-3 mt-0.5 shrink-0" />
                  Use {"{{first_name}}"} in subject for higher opens
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

      {/* Preview Dialog */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Eye className="h-4 w-4" /> Email Preview
            </DialogTitle>
            <DialogDescription>How your email will look to recipients</DialogDescription>
          </DialogHeader>
          <div className="border rounded-lg overflow-hidden">
            <div className="bg-muted/50 px-4 py-2 border-b">
              <p className="text-xs text-muted-foreground">Subject:</p>
              <p className="text-sm font-medium">{previewPersonalize(subject)}</p>
            </div>
            <div className="p-4 text-sm whitespace-pre-wrap leading-relaxed max-h-80 overflow-y-auto">
              {previewPersonalize(body)}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirmation Dialog */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mail className="h-5 w-5 text-primary" /> Confirm Email Broadcast
            </DialogTitle>
            <DialogDescription>
              This will send an email to all matching leads. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-3">
            {selectedList && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-accent/50">
                <ListFilter className="h-4 w-4" style={{ color: selectedList.color }} />
                <div>
                  <p className="text-sm font-medium">{selectedList.name}</p>
                  <p className="text-xs text-muted-foreground">~{previewCount ?? selectedList.lead_count} leads</p>
                </div>
              </div>
            )}
            <div className="p-3 rounded-lg bg-muted/50 border">
              <p className="text-xs text-muted-foreground mb-1">Subject:</p>
              <p className="text-sm font-medium">{previewPersonalize(subject)}</p>
              <p className="text-xs text-muted-foreground mt-2 mb-1">Body preview:</p>
              <p className="text-sm whitespace-pre-wrap line-clamp-4">{previewPersonalize(body)}</p>
            </div>
            <div className="flex items-center gap-2 p-2 rounded bg-amber-50 dark:bg-amber-950/20 text-amber-800 dark:text-amber-400 text-xs">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              Opted-out leads will be automatically skipped.
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button onClick={sendBroadcast} className="gap-1.5">
              <Mail className="h-4 w-4" /> Send to {previewCount ?? selectedList?.lead_count ?? 0} Leads
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
