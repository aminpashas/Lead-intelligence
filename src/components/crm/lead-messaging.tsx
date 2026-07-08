'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { sendBlockMessage } from '@/lib/messaging/send-block-messages'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  MessageSquare,
  Mail,
  Brain,
  Loader2,
  Send,
} from 'lucide-react'
import { toast } from 'sonner'
import type { ReactNode } from 'react'
import type { Lead } from '@/types/database'

// AI draft intents. `label` is what the operator reads; `subject` seeds the
// email subject line when the draft comes back and the field is still empty.
const AI_MODES = [
  { value: 'education', label: 'Educate about All-on-4', subject: 'Transform Your Smile with All-on-4 Dental Implants' },
  { value: 'objection_handling', label: 'Handle objections', subject: 'Addressing Your Questions About Dental Implants' },
  { value: 'appointment_scheduling', label: 'Schedule consultation', subject: 'Your Free Consultation Awaits' },
  { value: 'follow_up', label: 'Follow up', subject: 'Just Checking In' },
] as const

// value → label map for Base UI's <Select.Value> (it renders the raw value
// otherwise, which is why the trigger used to read "education").
const AI_MODE_LABELS = Object.fromEntries(AI_MODES.map((m) => [m.value, m.label]))

export function LeadMessaging({
  lead,
  defaultChannel,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  lead: Lead
  /** Which tab the dialog opens on. Falls back to SMS when the lead has a phone. */
  defaultChannel?: 'sms' | 'email'
  /** Custom trigger node. When omitted, renders the default "Send Message" chip. */
  trigger?: ReactNode
  /** Optional controlled open state (lets a parent bar open the dialog directly). */
  open?: boolean
  onOpenChange?: (v: boolean) => void
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = onOpenChange ?? setUncontrolledOpen
  const [sending, setSending] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [tab, setTab] = useState<string>(defaultChannel ?? (lead.phone ? 'sms' : 'email'))
  const [smsBody, setSmsBody] = useState('')
  const [emailSubject, setEmailSubject] = useState('')
  const [emailBody, setEmailBody] = useState('')
  const [aiMode, setAiMode] = useState('education')
  const router = useRouter()

  // When a parent opens the dialog to a specific channel, follow it.
  useEffect(() => {
    if (open && defaultChannel) setTab(defaultChannel)
  }, [open, defaultChannel])

  async function generateAI() {
    setGenerating(true)
    try {
      const res = await fetch('/api/ai/engage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lead_id: lead.id,
          mode: aiMode,
          channel: tab,
        }),
      })
      if (!res.ok) throw new Error('Generation failed')
      const { message } = await res.json()

      if (tab === 'sms') {
        setSmsBody(message)
      } else {
        setEmailBody(message)
        if (!emailSubject) {
          const mode = AI_MODES.find((m) => m.value === aiMode)
          setEmailSubject(mode?.subject ?? AI_MODES[0].subject)
        }
      }
      toast.success('AI draft generated — review and send')
    } catch {
      toast.error('Failed to generate message')
    } finally {
      setGenerating(false)
    }
  }

  async function sendMessage() {
    setSending(true)
    try {
      if (tab === 'sms') {
        if (!smsBody.trim()) { toast.error('Message is empty'); return }
        const res = await fetch('/api/sms/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lead_id: lead.id, message: smsBody }),
        })
        // Surface the server's real block reason (consent, quiet hours, etc.)
        // instead of a generic failure.
        if (!res.ok) {
          const data = await res.json().catch(() => null)
          toast.error(sendBlockMessage(data, 'Failed to send SMS'))
          return
        }
        toast.success('SMS sent!')
        setSmsBody('')
      } else {
        if (!emailBody.trim() || !emailSubject.trim()) { toast.error('Subject and body required'); return }
        const res = await fetch('/api/email/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lead_id: lead.id, subject: emailSubject, body: emailBody }),
        })
        if (!res.ok) {
          const data = await res.json().catch(() => null)
          toast.error(sendBlockMessage(data, 'Failed to send email'))
          return
        }
        toast.success('Email sent!')
        setEmailSubject('')
        setEmailBody('')
      }
      setOpen(false)
      router.refresh()
    } catch {
      toast.error(`Failed to send ${tab === 'sms' ? 'SMS' : 'email'}`)
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* A parent bar can drive the dialog via `open`/`onOpenChange` and pass no
          trigger; otherwise render the given trigger or the default chip. */}
      {controlledOpen === undefined && (
        <DialogTrigger>
          {trigger ?? (
            <span className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-aurea-border px-3 py-2 text-sm font-medium text-aurea-ink transition-colors hover:bg-aurea-surface-2">
              <MessageSquare className="h-4 w-4" strokeWidth={1.75} />
              Send Message
            </span>
          )}
        </DialogTrigger>
      )}
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="aurea-display text-[22px] text-aurea-ink">
            Message {lead.first_name} {lead.last_name}
          </DialogTitle>
          <p className="text-[13px] text-aurea-ink-3">
            Consent and quiet-hours are enforced automatically before anything sends.
          </p>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => v && setTab(v)} className="mt-1">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="sms" disabled={!lead.phone}>
              <MessageSquare className="mr-1.5 h-4 w-4" strokeWidth={1.75} /> SMS
            </TabsTrigger>
            <TabsTrigger value="email" disabled={!lead.email}>
              <Mail className="mr-1.5 h-4 w-4" strokeWidth={1.75} /> Email
            </TabsTrigger>
          </TabsList>

          {/* AI assist band — pick an intent, generate a draft to edit before sending. */}
          <div className="mt-4 rounded-xl border border-aurea-border bg-aurea-surface-2/50 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-aurea-ink-2">
              <Brain className="h-3.5 w-3.5 text-aurea-primary" strokeWidth={1.75} />
              <span className="aurea-eyebrow">AI draft</span>
            </div>
            <div className="flex items-center gap-2">
              <Select items={AI_MODE_LABELS} value={aiMode} onValueChange={(v) => v && setAiMode(v)}>
                <SelectTrigger className="h-9 flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AI_MODES.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                onClick={generateAI}
                disabled={generating}
                className="h-9 shrink-0 gap-1.5"
              >
                {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Brain className="h-3.5 w-3.5" strokeWidth={1.75} />}
                {generating ? 'Drafting…' : 'Generate'}
              </Button>
            </div>
          </div>

          <TabsContent value="sms" className="mt-4 space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-aurea-ink-3">To</Label>
              <span className="font-mono text-xs text-aurea-ink-2">{lead.phone}</span>
            </div>
            <Textarea
              value={smsBody}
              onChange={(e) => setSmsBody(e.target.value)}
              placeholder="Type your SMS message…"
              rows={5}
            />
            <p className="text-right font-mono text-[11px] tabular-nums text-aurea-ink-3">
              {smsBody.length}/160
              {smsBody.length > 160 && ` · ${Math.ceil(smsBody.length / 160)} segments`}
            </p>
          </TabsContent>

          <TabsContent value="email" className="mt-4 space-y-3">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-aurea-ink-3">To</Label>
                <span className="font-mono text-xs text-aurea-ink-2">{lead.email}</span>
              </div>
              <Input
                placeholder="Subject line"
                value={emailSubject}
                onChange={(e) => setEmailSubject(e.target.value)}
              />
            </div>
            <Textarea
              value={emailBody}
              onChange={(e) => setEmailBody(e.target.value)}
              placeholder="Compose your email…"
              rows={9}
            />
          </TabsContent>
        </Tabs>

        <div className="mt-2 flex justify-end gap-2 border-t border-aurea-border pt-4">
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={sendMessage} disabled={sending} className="gap-1.5">
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" strokeWidth={1.75} />}
            Send {tab === 'sms' ? 'SMS' : 'Email'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
