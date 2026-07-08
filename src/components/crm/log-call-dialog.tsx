'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Phone, Loader2, ChevronDown, BookOpen } from 'lucide-react'
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

// Mirrors the lead.budget_range enum. 'no_change' is a UI-only sentinel meaning
// "don't touch the lead's budget" (not sent to the API).
const NO_CHANGE = 'no_change'
const BUDGET_RANGES = [
  { value: 'under_10k', label: 'Under $10k' },
  { value: '10k_15k', label: '$10k–$15k' },
  { value: '15k_20k', label: '$15k–$20k' },
  { value: '20k_25k', label: '$20k–$25k' },
  { value: '25k_30k', label: '$25k–$30k' },
  { value: 'over_30k', label: 'Over $30k' },
  { value: 'unknown', label: 'Unknown' },
] as const

// Base UI's <SelectValue> renders the raw value, so map each value → trigger label.
const DIRECTION_LABELS = { outbound: 'Outbound', inbound: 'Inbound' }
const OUTCOME_LABELS = Object.fromEntries(OUTCOMES.map((o) => [o.value, o.label]))
const BUDGET_LABELS = {
  [NO_CHANGE]: 'No change',
  ...Object.fromEntries(BUDGET_RANGES.map((b) => [b.value, b.label])),
}

export function LogCallDialog({ leadId }: { leadId: string }) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [direction, setDirection] = useState<'outbound' | 'inbound'>('outbound')
  const [outcome, setOutcome] = useState<string>('interested')
  const [minutes, setMinutes] = useState('')
  const [notes, setNotes] = useState('')
  const [budgetRange, setBudgetRange] = useState<string>(NO_CHANGE)
  const [testimonialSent, setTestimonialSent] = useState(false)
  const [painPoints, setPainPoints] = useState('')
  const [guideOpen, setGuideOpen] = useState(false)
  const [script, setScript] = useState<string | null>(null)
  const [scriptLoading, setScriptLoading] = useState(false)
  const router = useRouter()

  // Fetch the practice's discovery script the first time the dialog opens.
  useEffect(() => {
    if (!open || script !== null || scriptLoading) return
    setScriptLoading(true)
    fetch('/api/discovery-script')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setScript(typeof data?.script === 'string' ? data.script : ''))
      .catch(() => setScript(''))
      .finally(() => setScriptLoading(false))
  }, [open, script, scriptLoading])

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
          budget_range: budgetRange === NO_CHANGE ? null : budgetRange,
          testimonial_sent: testimonialSent,
          pain_points: painPoints.trim() || null,
        }),
      })
      if (!res.ok) throw new Error('Save failed')
      toast.success('Call logged')
      setMinutes('')
      setNotes('')
      setBudgetRange(NO_CHANGE)
      setTestimonialSent(false)
      setPainPoints('')
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
          {/* Collapsible discovery-call guide */}
          <div className="rounded-lg border border-aurea-border">
            <button
              type="button"
              onClick={() => setGuideOpen((v) => !v)}
              aria-expanded={guideOpen}
              className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium text-aurea-ink transition-colors hover:bg-aurea-surface-2"
            >
              <span className="inline-flex items-center gap-2">
                <BookOpen className="h-4 w-4 text-aurea-ink-3" strokeWidth={1.75} />
                Discovery script
              </span>
              <ChevronDown
                className={`h-4 w-4 text-aurea-ink-3 transition-transform ${guideOpen ? 'rotate-180' : ''}`}
                strokeWidth={1.75}
              />
            </button>
            {guideOpen && (
              <div className="border-t border-aurea-border px-3 py-2.5">
                {scriptLoading ? (
                  <div className="flex items-center gap-2 text-sm text-aurea-ink-3">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading script…
                  </div>
                ) : (
                  <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap font-sans text-xs leading-relaxed text-aurea-ink-2">
                    {script || 'No discovery script configured.'}
                  </pre>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label className="text-xs text-aurea-ink-3">Direction</Label>
              <Select items={DIRECTION_LABELS} value={direction} onValueChange={(v) => v && setDirection(v as 'outbound' | 'inbound')}>
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
            <Select items={OUTCOME_LABELS} value={outcome} onValueChange={(v) => v && setOutcome(v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {OUTCOMES.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-aurea-ink-3">Budget range</Label>
            <Select items={BUDGET_LABELS} value={budgetRange} onValueChange={(v) => v && setBudgetRange(v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CHANGE}>No change</SelectItem>
                {BUDGET_RANGES.map((b) => (
                  <SelectItem key={b.value} value={b.value}>{b.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-aurea-ink-3">Pain points</Label>
            <Textarea value={painPoints} onChange={(e) => setPainPoints(e.target.value)} placeholder="What's driving them? (added to the lead's profile)" rows={2} />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-aurea-border px-3 py-2">
            <Label htmlFor="testimonial-sent" className="text-sm text-aurea-ink">Testimonial sent during call</Label>
            <Switch id="testimonial-sent" checked={testimonialSent} onCheckedChange={setTestimonialSent} />
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
