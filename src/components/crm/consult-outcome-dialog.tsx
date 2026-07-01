'use client'

import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Loader2 } from 'lucide-react'

const OUTCOMES = [
  { value: 'treatment_accepted', label: 'Treatment accepted' },
  { value: 'deposit_paid', label: 'Deposit paid' },
  { value: 'considering', label: 'Considering / thinking it over' },
  { value: 'declined', label: 'Declined' },
  { value: 'referred_out', label: 'Referred out' },
  { value: 'no_decision', label: 'No decision yet' },
] as const

const REASONS = [
  { value: 'price', label: 'Price' },
  { value: 'financing', label: 'Financing' },
  { value: 'timing', label: 'Timing' },
  { value: 'second_opinion', label: 'Wants a second opinion' },
  { value: 'medical', label: 'Medical' },
  { value: 'spouse_partner', label: 'Spouse/partner to decide' },
  { value: 'other', label: 'Other' },
] as const

export function ConsultOutcomeDialog({
  appointmentId, patientName, open, onOpenChange, onSaved,
}: {
  appointmentId: string
  patientName: string
  open: boolean
  onOpenChange: (v: boolean) => void
  onSaved: () => void
}) {
  const [outcome, setOutcome] = useState<string>('')
  const [reason, setReason] = useState<string>('')
  const [quotedDollars, setQuotedDollars] = useState<string>('')
  const [notes, setNotes] = useState<string>('')
  const [followUp, setFollowUp] = useState<string>('')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!outcome) return
    setSaving(true)
    try {
      await fetch(`/api/appointments/${appointmentId}/outcome`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outcome,
          reason: outcome === 'declined' && reason ? reason : undefined,
          quoted_value_cents: quotedDollars ? Math.round(parseFloat(quotedDollars) * 100) : undefined,
          notes: notes || undefined,
          follow_up_at: followUp ? new Date(followUp).toISOString() : undefined,
        }),
      })
      onSaved()
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Consult outcome — {patientName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Outcome</Label>
            <Select value={outcome} onValueChange={(v) => v && setOutcome(v)}>
              <SelectTrigger><SelectValue placeholder="Select an outcome" /></SelectTrigger>
              <SelectContent>
                {OUTCOMES.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {outcome === 'declined' && (
            <div className="space-y-1.5">
              <Label>Reason for declining</Label>
              <Select value={reason} onValueChange={(v) => v && setReason(v)}>
                <SelectTrigger><SelectValue placeholder="Select a reason" /></SelectTrigger>
                <SelectContent>
                  {REASONS.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Quoted treatment value (USD, optional)</Label>
            <Input type="number" min="0" step="1" value={quotedDollars}
              onChange={(e) => setQuotedDollars(e.target.value)} placeholder="e.g. 24000" />
          </div>

          <div className="space-y-1.5">
            <Label>Notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)}
              placeholder="What happened in the consult?" rows={3} />
          </div>

          <div className="space-y-1.5">
            <Label>Follow-up date (optional)</Label>
            <Input type="date" value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={!outcome || saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Save outcome
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
