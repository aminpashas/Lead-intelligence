'use client'

/**
 * HoldLead — put a lead on hold until a date. Suppresses ALL outbound
 * automation until then (dialer, campaigns, sequences); mints a dated callback
 * task on /tasks. Clearing removes the hold and completes that task.
 * PUT/DELETE /api/leads/[id]/hold.
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PauseCircle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type { Lead } from '@/types/database'

/** Local YYYY-MM-DD for an <input type="date">, `days` from today. */
function dateInputValue(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const PRESETS: { label: string; days: number }[] = [
  { label: '+3 days', days: 3 },
  { label: '+1 week', days: 7 },
  { label: '+2 weeks', days: 14 },
  { label: '+1 month', days: 30 },
]

export function HoldLead({ lead }: { lead: Lead }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const alreadyHeld = !!lead.hold_until && new Date(lead.hold_until).getTime() > Date.now()
  const [date, setDate] = useState<string>(
    lead.hold_until ? lead.hold_until.slice(0, 10) : dateInputValue(7),
  )
  const [reason, setReason] = useState<string>(lead.hold_reason ?? '')
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!date) {
      toast.error('Pick a date')
      return
    }
    setSaving(true)
    try {
      const holdUntil = new Date(`${date}T12:00:00`).toISOString() // noon-local, no UTC shift
      const res = await fetch(`/api/leads/${lead.id}/hold`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ holdUntil, reason: reason.trim() || null }),
      })
      if (!res.ok) throw new Error(String(res.status))
      toast.success(`On hold until ${date} — automation paused`)
      setOpen(false)
      router.refresh()
    } catch {
      toast.error('Could not save. Try again.')
    } finally {
      setSaving(false)
    }
  }

  async function clear() {
    setSaving(true)
    try {
      const res = await fetch(`/api/leads/${lead.id}/hold`, { method: 'DELETE' })
      if (!res.ok) throw new Error(String(res.status))
      toast.success('Hold cleared')
      setOpen(false)
      router.refresh()
    } catch {
      toast.error('Could not clear. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <PauseCircle className="h-4 w-4" strokeWidth={1.75} />
            {alreadyHeld ? 'On hold' : 'Hold'}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{alreadyHeld ? 'Update hold' : 'Put lead on hold'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <Button
                key={p.days}
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setDate(dateInputValue(p.days))}
              >
                {p.label}
              </Button>
            ))}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="hold-date">Hold until</Label>
            <Input
              id="hold-date"
              type="date"
              value={date}
              min={dateInputValue(1)}
              onChange={(e) => setDate(e.target.value)}
            />
            <p className="text-[11px] text-aurea-ink-3">
              No automated calls, texts, or emails until this date. You can still reach out manually.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="hold-reason">Reason (optional)</Label>
            <Input
              id="hold-reason"
              placeholder="e.g. wants to talk it over with spouse"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          {alreadyHeld && (
            <Button variant="ghost" onClick={clear} disabled={saving}>
              Clear hold
            </Button>
          )}
          <DialogClose render={<Button variant="ghost">Cancel</Button>} />
          <Button onClick={save} disabled={saving}>
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <PauseCircle className="h-4 w-4" strokeWidth={1.75} />
            )}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
