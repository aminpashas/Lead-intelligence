'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
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
import type { Lead } from '@/types/database'

export function LeadMessaging({ lead }: { lead: Lead }) {
  const [open, setOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [tab, setTab] = useState<string>(lead.phone ? 'sms' : 'email')
  const [smsBody, setSmsBody] = useState('')
  const [emailSubject, setEmailSubject] = useState('')
  const [emailBody, setEmailBody] = useState('')
  const [aiMode, setAiMode] = useState('education')
  const router = useRouter()

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
          setEmailSubject(
            aiMode === 'education' ? 'Transform Your Smile with All-on-4 Dental Implants' :
            aiMode === 'appointment_scheduling' ? 'Your Free Consultation Awaits' :
            aiMode === 'follow_up' ? 'Just Checking In' :
            'Addressing Your Questions About Dental Implants'
          )
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
        if (!res.ok) throw new Error('Send failed')
        toast.success('SMS sent!')
        setSmsBody('')
      } else {
        if (!emailBody.trim() || !emailSubject.trim()) { toast.error('Subject and body required'); return }
        const res = await fetch('/api/email/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lead_id: lead.id, subject: emailSubject, body: emailBody }),
        })
        if (!res.ok) throw new Error('Send failed')
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
      <DialogTrigger>
        <span className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent cursor-pointer">
          <MessageSquare className="h-4 w-4" />
          Send Message
        </span>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Message {lead.first_name} {lead.last_name}
          </DialogTitle>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => v && setTab(v)} className="mt-2">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="sms" disabled={!lead.phone}>
              <MessageSquare className="h-4 w-4 mr-1.5" /> SMS
            </TabsTrigger>
            <TabsTrigger value="email" disabled={!lead.email}>
              <Mail className="h-4 w-4 mr-1.5" /> Email
            </TabsTrigger>
          </TabsList>

          {/* AI Generate */}
          <div className="flex items-center gap-2 mt-4">
            <Select value={aiMode} onValueChange={(v) => v && setAiMode(v)}>
              <SelectTrigger className="flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="education">Educate about All-on-4</SelectItem>
                <SelectItem value="objection_handling">Handle Objections</SelectItem>
                <SelectItem value="appointment_scheduling">Schedule Consultation</SelectItem>
                <SelectItem value="follow_up">Follow Up</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={generateAI}
              disabled={generating}
              className="gap-1.5 shrink-0"
            >
              {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Brain className="h-3.5 w-3.5" />}
              AI Draft
            </Button>
          </div>

          <TabsContent value="sms" className="space-y-3 mt-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">To: {lead.phone}</Label>
              <Textarea
                value={smsBody}
                onChange={(e) => setSmsBody(e.target.value)}
                placeholder="Type your SMS message..."
                rows={4}
              />
              <p className="text-xs text-muted-foreground text-right">
                {smsBody.length}/160 characters
                {smsBody.length > 160 && ` (${Math.ceil(smsBody.length / 160)} segments)`}
              </p>
            </div>
          </TabsContent>

          <TabsContent value="email" className="space-y-3 mt-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">To: {lead.email}</Label>
              <Input
                placeholder="Subject line"
                value={emailSubject}
                onChange={(e) => setEmailSubject(e.target.value)}
              />
            </div>
            <Textarea
              value={emailBody}
              onChange={(e) => setEmailBody(e.target.value)}
              placeholder="Compose your email..."
              rows={8}
            />
          </TabsContent>
        </Tabs>

        <div className="flex justify-end gap-2 mt-2">
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={sendMessage} disabled={sending} className="gap-1.5">
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send {tab === 'sms' ? 'SMS' : 'Email'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
