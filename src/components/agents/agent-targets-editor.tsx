'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from 'sonner'
import { KPI_LABELS, KPI_UNITS, DISPLAY_ONLY_KPIS } from '@/lib/agents/kpi-status'

type TargetRow = {
  id: string
  kpi_name: string
  target_value: number
  warning_threshold: number
  critical_threshold: number
  direction: 'higher_is_better' | 'lower_is_better'
}

export function AgentTargetsEditor({
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
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [targets, setTargets] = useState<TargetRow[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/agents/${agentId}/targets`)
      if (!res.ok) throw new Error(`API ${res.status}`)
      const json = (await res.json()) as { targets: TargetRow[] }
      setTargets(
        json.targets.filter((t) => !DISPLAY_ONLY_KPIS.has(t.kpi_name))
      )
    } catch (e) {
      toast.error(`Failed to load targets: ${e instanceof Error ? e.message : 'unknown'}`)
    } finally {
      setLoading(false)
    }
  }, [agentId])

  useEffect(() => {
    void load()
  }, [load])

  const updateField = (index: number, field: keyof TargetRow, value: number | string) => {
    setTargets((prev) => prev.map((t, i) => (i === index ? { ...t, [field]: value } : t)))
  }

  const save = async () => {
    setSaving(true)
    try {
      const res = await fetch(`/api/agents/${agentId}/targets`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targets: targets.map((t) => ({
            kpi_name: t.kpi_name,
            target_value: Number(t.target_value),
            warning_threshold: Number(t.warning_threshold),
            critical_threshold: Number(t.critical_threshold),
            direction: t.direction,
          })),
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Save failed' }))
        throw new Error(err.error || `API ${res.status}`)
      }
      toast.success('Targets updated')
      onSaved()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit KPI Targets — {agentName}</DialogTitle>
          <DialogDescription>
            Set target, warning, and critical thresholds per KPI. Green when value meets target, yellow within warning, red past critical.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="space-y-2">
            {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
          </div>
        ) : (
          <div className="space-y-3 py-2">
            <div className="grid grid-cols-12 gap-2 text-xs font-medium text-muted-foreground px-1">
              <div className="col-span-4">KPI</div>
              <div className="col-span-2">Target</div>
              <div className="col-span-2">Warning</div>
              <div className="col-span-2">Critical</div>
              <div className="col-span-2">Direction</div>
            </div>
            {targets.map((t, i) => {
              const unitSuffix = KPI_UNITS[t.kpi_name] === 'percent'
                ? '%'
                : KPI_UNITS[t.kpi_name] === 'minutes'
                  ? 'min'
                  : KPI_UNITS[t.kpi_name] === 'rating'
                    ? '/5'
                    : ''
              return (
                <div key={t.id} className="grid grid-cols-12 gap-2 items-center">
                  <Label className="col-span-4 text-sm">{KPI_LABELS[t.kpi_name] || t.kpi_name}</Label>
                  <div className="col-span-2 relative">
                    <Input
                      type="number"
                      step="0.1"
                      value={t.target_value}
                      onChange={(e) => updateField(i, 'target_value', Number(e.target.value))}
                      className="pr-8"
                    />
                    {unitSuffix && <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">{unitSuffix}</span>}
                  </div>
                  <div className="col-span-2">
                    <Input
                      type="number"
                      step="0.1"
                      value={t.warning_threshold}
                      onChange={(e) => updateField(i, 'warning_threshold', Number(e.target.value))}
                    />
                  </div>
                  <div className="col-span-2">
                    <Input
                      type="number"
                      step="0.1"
                      value={t.critical_threshold}
                      onChange={(e) => updateField(i, 'critical_threshold', Number(e.target.value))}
                    />
                  </div>
                  <div className="col-span-2">
                    <Select
                      value={t.direction}
                      onValueChange={(v) => updateField(i, 'direction', v as TargetRow['direction'])}
                    >
                      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="higher_is_better">Higher</SelectItem>
                        <SelectItem value="lower_is_better">Lower</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving || loading}>
            {saving ? 'Saving…' : 'Save targets'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
