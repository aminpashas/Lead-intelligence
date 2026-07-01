'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Phone, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

const OUTCOMES = [
  { value: 'interested', label: 'Interested' },
  { value: 'appointment_booked', label: 'Appointment booked' },
  { value: 'callback_requested', label: 'Callback requested' },
  { value: 'not_interested', label: 'Not interested' },
  { value: 'no_answer', label: 'No answer' },
  { value: 'voicemail_left', label: 'Voicemail left' },
  { value: 'wrong_number', label: 'Wrong number' },
  { value: 'do_not_call', label: 'Do not call' },
] as const

export function LogCallDialog({ leadId }: { leadId: string }) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [direction, setDirection] = useState<'outbound' | 'inbound'>('outbound')
  const [outcome, setOutcome] = useState<string>('interested')
  const [minutes, setMinutes] = useState('')
  const [notes, setNotes] = useState('')
  const router = useRouter()

  async function save() {
    setSaving(true)
    try {
      const res = await fetch(`/api/leads/${leadId}/calls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          direction,
          outcome,
          duration_seconds: Math.round((parseFloat(minutes) || 0) * 60),
          notes: notes.trim() || null,
        }),
      })
      if (!res.ok) throw new Error('Save failed')
      toast.success('Call logged')
      setMinutes('')
      setNotes('')
      setOpen(false)
      router.refresh()
    } catch {
      toast.error('Failed to log call')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger>
        <span className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-aurea-border px-3 py-2 text-sm font-medium text-aurea-ink transition-colors hover:bg-aurea-surface-2">
          <Phone className="h-4 w-4" strokeWidth={1.75} />
          Log Call
        </span>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="aurea-display text-[22px] text-aurea-ink">Log a call</DialogTitle>
        </DialogHeader>

        <div className="mt-2 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label className="text-xs text-aurea-ink-3">Direction</Label>
              <Select value={direction} onValueChange={(v) => v && setDirection(v as 'outbound' | 'inbound')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="outbound">Outbound</SelectItem>
                  <SelectItem value="inbound">Inbound</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-aurea-ink-3">Duration (min)</Label>
              <Input type="number" min="0" step="0.5" value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="0" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-aurea-ink-3">Outcome</Label>
            <Select value={outcome} onValueChange={(v) => v && setOutcome(v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {OUTCOMES.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-aurea-ink-3">Notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What was discussed?" rows={4} />
          </div>
        </div>

        <div className="mt-3 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving} className="gap-1.5">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Phone className="h-4 w-4" strokeWidth={1.75} />}
            Log call
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
