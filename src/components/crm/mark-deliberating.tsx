'use client'

/**
 * MarkDeliberating — the closer's "they're thinking about it" control.
 *
 * A patient who has seen the plan and is actively deciding ("let me talk to my
 * spouse / think / save up") is engaged-and-waiting — not Lost, not gone quiet.
 * This dialog parks the deal as `closing_temperature = 'deliberating'` with a
 * follow-up date, so it drops out of the closer's live queue until the timer
 * fires (see closingQueueState in src/lib/pipeline/closing.ts).
 *
 * Writes via PATCH /api/leads/[id]/closing. Reason reuses the shared objection
 * vocabulary (leads.primary_objection).
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Clock, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type { Lead } from '@/types/database'

/** Why they paused → leads.primary_objection. Ordered by how often it comes up. */
const REASON_LABELS: Record<string, string> = {
  spouse_approval: 'Talking it over with spouse/family',
  financing: 'Sorting out financing / saving up',
  cost: 'Thinking about the cost',
  timing: 'Timing not right yet',
  trust: 'Wants a second opinion',
  other: 'Other',
}

/** Local YYYY-MM-DD for an <input type="date">, `days` from today. */
function dateInputValue(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function MarkDeliberating({ lead }: { lead: Lead }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<string>(lead.primary_objection ?? 'spouse_approval')
  // Prefill from an existing timer, else default to two weeks out.
  const [date, setDate] = useState<string>(
    lead.closing_follow_up_at ? lead.closing_follow_up_at.slice(0, 10) : dateInputValue(14)
  )
  const [note, setNote] = useState<string>(lead.closing_next_step ?? '')
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!date) {
      toast.error('Pick a follow-up date')
      return
    }
    setSaving(true)
    try {
      // Noon local avoids a UTC day-shift when the date is read back.
      const followUpAt = new Date(`${date}T12:00:00`).toISOString()
      const res = await fetch(`/api/leads/${lead.id}/closing`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          temperature: 'deliberating',
          followUpAt,
          reason,
          nextStep: note.trim() || null,
        }),
      })
      if (!res.ok) throw new Error(String(res.status))
      toast.success('Marked deliberating — will resurface on the follow-up date')
      setOpen(false)
      router.refresh()
    } catch {
      toast.error('Could not save. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <Clock className="h-4 w-4" strokeWidth={1.75} />
            Deliberating
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark as deliberating</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Why are they waiting?</Label>
            <Select items={REASON_LABELS} value={reason} onValueChange={(v) => setReason(String(v))}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(REASON_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="deliberating-date">Follow up on</Label>
            <Input
              id="deliberating-date"
              type="date"
              value={date}
              min={dateInputValue(0)}
              onChange={(e) => setDate(e.target.value)}
            />
            <p className="text-[11px] text-aurea-ink-3">
              Until then this deal is muted from the live queue.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="deliberating-note">Next step (optional)</Label>
            <Input
              id="deliberating-note"
              placeholder="e.g. call after she talks to husband"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="ghost">Cancel</Button>} />
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clock className="h-4 w-4" strokeWidth={1.75} />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
