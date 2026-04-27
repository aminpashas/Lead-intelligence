'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { type AgentGrade, STATUS_LABELS } from '@/lib/agents/grading'

const GRADE_OPTIONS: AgentGrade[] = ['green', 'yellow', 'red', 'probation']

export function ManualOverrideDialog({
  agentId,
  agentName,
  onClose,
  onSaved,
}: {
  agentId: string
  agentName: string
  onClose: () => void
  onSaved: () => void
}) {
  const [grade, setGrade] = useState<AgentGrade>('green')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (notes.trim().length < 5) {
      setError('Please add a justification (≥5 chars).')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/agents/${agentId}/reviews/manual-override`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grade, notes: notes.trim() }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        throw new Error(json?.error || `Status ${res.status}`)
      }
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Override status — {agentName}</CardTitle>
          <CardDescription>
            Manual overrides are audit-logged with your account. Use this to clear probation, escalate
            an underperforming agent, or correct a system review.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="text-xs font-medium uppercase text-muted-foreground">New status</label>
            <Select value={grade} onValueChange={(v) => setGrade(v as AgentGrade)}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GRADE_OPTIONS.map((g) => (
                  <SelectItem key={g} value={g}>
                    {STATUS_LABELS[g]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium uppercase text-muted-foreground">
              Justification
            </label>
            <Textarea
              className="mt-1"
              rows={4}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Why is this override warranted? E.g. data anomaly, integration outage skewed booking rate, hands-on coaching plan in place."
            />
          </div>
          {error && <div className="text-sm text-rose-600">{error}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={saving}>
              {saving ? 'Saving…' : 'Save override'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
