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
  Mail, Users, ListFilter, Loader2, CheckCircle2,
  AlertTriangle, Sparkles, AtSign, XCircle, Clock,
  Eye, Send,
} from 'lucide-react'
import { toast } from 'sonner'
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
  const [eligibility, setEligibility] = useState<null | {
    email: { total: number; eligible: number; no_consent: number; opted_out: number; no_contact: number }
    list_total: number
    capped: boolean
  }>(null)
  const [activeField, setActiveField] = useState<'subject' | 'body'>('body')

  useEffect(() => { fetchSmartLists() }, [])

  useEffect(() => {
    if (selectedListId) { fetchPreviewCount(); fetchEligibility() }
    else { setPreviewCount(null); setEligibility(null) }
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

  // Consent/eligibility breakdown — how many recipients are actually reachable by email.
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
          <div className="inline-flex items-center justify-center h-16 w-16 rounded-full bg-aurea-primary/10 mx-auto">
            <CheckCircle2 className="h-8 w-8 text-aurea-primary" strokeWidth={1.75} />
          </div>
          <div>
            <h2 className="aurea-display text-[22px] text-aurea-ink">Email Broadcast Complete</h2>
            <p className="text-aurea-ink-3 mt-1 text-[13px]">{broadcastName || 'Mass Email'}</p>
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
            <Button variant="outline" onClick={() => {
              setStatus('idle'); setResults(null); setSubject(''); setBody(''); setBroadcastName('')
            }}>Send Another</Button>
            <Button variant="outline" onClick={() => window.location.href = '/campaigns/broadcasts/audit'}>
              View Audit Log
            </Button>
            {onClose && <Button onClick={onClose}>Done</Button>}
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
        <h2 className="aurea-display text-[28px] text-aurea-ink">Mass Email Broadcast</h2>
        <p className="mt-1 text-[13px] text-aurea-ink-2">
          Send a personalized email to an entire Smart List at once
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Left: Compose */}
        <div className="lg:col-span-2 space-y-4">
          {/* Select Smart List */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-1.5 text-aurea-ink">
                <ListFilter className="h-[17px] w-[17px] text-aurea-ink-3" strokeWidth={1.75} /> Target Audience
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
                  <div className="h-10 w-10 rounded-lg flex items-center justify-center bg-aurea-surface-2 border border-aurea-border">
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
                        <><AtSign className="h-3 w-3 inline mr-0.5" />
                          {previewCount !== null ? `${previewCount} leads with email` : `${selectedList.lead_count} leads`}</>
                      )}
                    </p>
                    {eligibility && (
                      <p className="mt-0.5 text-[11px] text-aurea-ink-3">
                        <span className="font-medium text-aurea-primary">
                          {eligibility.email.eligible.toLocaleString()} email-eligible
                        </span>
                        {eligibility.email.total > eligibility.email.eligible && (
                          <>
                            {' · '}
                            {(eligibility.email.total - eligibility.email.eligible).toLocaleString()} excluded
                            {' ('}
                            {[
                              eligibility.email.no_consent > 0 ? `${eligibility.email.no_consent} no consent` : null,
                              eligibility.email.opted_out > 0 ? `${eligibility.email.opted_out} opted out` : null,
                              eligibility.email.no_contact > 0 ? `${eligibility.email.no_contact} no email` : null,
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

          {/* Compose Email */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-1.5 text-aurea-ink">
                <Mail className="h-[17px] w-[17px] text-aurea-ink-3" strokeWidth={1.75} /> Compose Email
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <Label className="text-[11px] text-aurea-ink-3">Broadcast Name (optional)</Label>
                <Input
                  value={broadcastName}
                  onChange={(e) => setBroadcastName(e.target.value)}
                  placeholder="e.g. March Reactivation Email"
                  className="h-8 text-sm"
                />
              </div>

              <div className="space-y-2">
                <Label className="text-[13px] text-aurea-ink">Subject Line</Label>
                <Input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  onFocus={() => setActiveField('subject')}
                  placeholder="Your Free Consultation Awaits, {{first_name}}"
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-[13px] text-aurea-ink">Email Body</Label>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-[11px] gap-1 text-aurea-ink-2 hover:text-aurea-ink"
                    onClick={() => setPreviewOpen(true)}
                    disabled={!body}
                  >
                    <Eye className="h-3 w-3" strokeWidth={1.75} /> Preview
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
                <span className="text-[10px] text-aurea-ink-3">20+ personalization fields</span>
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
              <CardTitle className="text-sm flex items-center gap-1.5 text-aurea-ink">
                <Sparkles className="h-[17px] w-[17px] text-aurea-amber" strokeWidth={1.75} /> Email Templates
              </CardTitle>
              <CardDescription className="text-[11px] text-aurea-ink-3">Click to apply</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {EMAIL_TEMPLATES.map((t) => (
                <button
                  key={t.name}
                  onClick={() => applyTemplate(t)}
                  className="w-full text-left p-2.5 rounded-lg border border-aurea-border hover:bg-aurea-surface-2 transition-colors"
                >
                  <p className="text-[12px] font-medium text-aurea-ink">{t.name}</p>
                  <p className="text-[10px] text-aurea-ink-3 mt-0.5 truncate">{t.subject}</p>
                </button>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-1.5 text-aurea-ink">
                <AlertTriangle className="h-[17px] w-[17px] text-aurea-amber" strokeWidth={1.75} /> Best Practices
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1.5 text-[11px] text-aurea-ink-3">
                <li className="flex items-start gap-1.5">
                  <Clock className="h-3 w-3 mt-0.5 shrink-0" strokeWidth={1.75} />
                  Tue-Thu mornings get the best open rates
                </li>
                <li className="flex items-start gap-1.5">
                  <Mail className="h-3 w-3 mt-0.5 shrink-0" strokeWidth={1.75} />
                  Keep subject lines under 50 characters
                </li>
                <li className="flex items-start gap-1.5">
                  <Users className="h-3 w-3 mt-0.5 shrink-0" strokeWidth={1.75} />
                  Use {"{{first_name}}"} in subject for higher opens
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

      {/* Preview Dialog */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-aurea-ink">
              <Eye className="h-[17px] w-[17px] text-aurea-ink-3" strokeWidth={1.75} /> Email Preview
            </DialogTitle>
            <DialogDescription className="text-aurea-ink-3">How your email will look to recipients</DialogDescription>
          </DialogHeader>
          <div className="border border-aurea-border rounded-lg overflow-hidden">
            <div className="bg-aurea-surface-2 px-4 py-2 border-b border-aurea-border">
              <p className="text-[11px] text-aurea-ink-3">Subject:</p>
              <p className="text-[13px] font-medium text-aurea-ink">{previewPersonalize(subject)}</p>
            </div>
            <div className="p-4 text-[13px] text-aurea-ink-2 whitespace-pre-wrap leading-relaxed max-h-80 overflow-y-auto">
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
            <DialogTitle className="flex items-center gap-2 text-aurea-ink">
              <Mail className="h-[17px] w-[17px] text-aurea-primary" strokeWidth={1.75} /> Confirm Email Broadcast
            </DialogTitle>
            <DialogDescription className="text-aurea-ink-3">
              This will send an email to all matching leads. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-3">
            {selectedList && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-aurea-surface-2 border border-aurea-border">
                <ListFilter className="h-[17px] w-[17px] text-aurea-ink-3" strokeWidth={1.75} />
                <div>
                  <p className="text-[13px] font-medium text-aurea-ink">{selectedList.name}</p>
                  <p className="text-[11px] text-aurea-ink-3 font-mono tabular-nums">~{previewCount ?? selectedList.lead_count} leads</p>
                </div>
              </div>
            )}
            <div className="p-3 rounded-lg bg-aurea-surface-2 border border-aurea-border">
              <p className="text-[11px] text-aurea-ink-3 mb-1">Subject:</p>
              <p className="text-[13px] font-medium text-aurea-ink">{previewPersonalize(subject)}</p>
              <p className="text-[11px] text-aurea-ink-3 mt-2 mb-1">Body preview:</p>
              <p className="text-[13px] text-aurea-ink-2 whitespace-pre-wrap line-clamp-4">{previewPersonalize(body)}</p>
            </div>
            <div className="flex items-center gap-2 p-2 rounded-lg bg-aurea-amber/10 border border-aurea-amber/20 text-aurea-amber text-[11px]">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
              Opted-out leads will be automatically skipped.
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button onClick={sendBroadcast} className="gap-1.5">
              <Mail className="h-4 w-4" strokeWidth={1.75} /> Send to {previewCount ?? selectedList?.lead_count ?? 0} Leads
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
