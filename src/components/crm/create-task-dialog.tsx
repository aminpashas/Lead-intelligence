'use client'

import { useEffect, useMemo, useState } from 'react'
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
import { Plus, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

type Member = {
  id: string
  full_name: string | null
  email: string | null
  is_active: boolean | null
}

const PRIORITIES = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
] as const

const PRIORITY_LABELS = Object.fromEntries(PRIORITIES.map((p) => [p.value, p.label]))

// UI-only sentinel — Base UI's Select needs a concrete value, so "no assignee"
// is represented by this instead of an empty string (which it treats as unset).
const UNASSIGNED = '__unassigned__'

/**
 * Hand-create a task (kind='manual') from the /tasks page: title, detail,
 * priority, deadline, and an assignee drawn from the org's team members.
 * Calls onCreated() so the parent list can refetch.
 */
export function CreateTaskDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [title, setTitle] = useState('')
  const [detail, setDetail] = useState('')
  const [priority, setPriority] = useState<string>('normal')
  const [dueAt, setDueAt] = useState('') // datetime-local string
  const [assignee, setAssignee] = useState<string>(UNASSIGNED)
  const [members, setMembers] = useState<Member[]>([])

  // Load the org's team members for the assignee picker when first opened.
  useEffect(() => {
    if (!open || members.length > 0) return
    fetch('/api/team')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const list: Member[] = (data?.members ?? []).filter((m: Member) => m.is_active !== false)
        setMembers(list)
      })
      .catch(() => setMembers([]))
  }, [open, members.length])

  // value → label map for Base UI's <SelectValue> (assignee trigger display).
  const assigneeLabels = useMemo(() => {
    const map: Record<string, string> = { [UNASSIGNED]: 'Unassigned' }
    for (const m of members) map[m.id] = m.full_name || m.email || 'Team member'
    return map
  }, [members])

  function resetForm() {
    setTitle('')
    setDetail('')
    setPriority('normal')
    setDueAt('')
    setAssignee(UNASSIGNED)
  }

  async function save() {
    if (!title.trim()) {
      toast.error('Give the task a title')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          detail: detail.trim() || null,
          priority,
          // datetime-local is wall-clock with no zone; interpret it in the
          // browser's zone and send an absolute ISO instant.
          due_at: dueAt ? new Date(dueAt).toISOString() : null,
          assigned_to: assignee === UNASSIGNED ? null : assignee,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error || 'Failed to create task')
      }
      toast.success('Task created')
      resetForm()
      setOpen(false)
      onCreated()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create task')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger>
        <span className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-aurea-primary px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90">
          <Plus className="h-4 w-4" strokeWidth={2} />
          New task
        </span>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="aurea-display text-[22px] text-aurea-ink">New task</DialogTitle>
        </DialogHeader>

        <div className="mt-2 space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-aurea-ink-3">Title</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Call back Dr. Lee about financing"
              autoFocus
              maxLength={200}
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label className="text-xs text-aurea-ink-3">Priority</Label>
              <Select items={PRIORITY_LABELS} value={priority} onValueChange={(v) => v && setPriority(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-aurea-ink-3">Deadline</Label>
              <Input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-aurea-ink-3">Assign to</Label>
            <Select items={assigneeLabels} value={assignee} onValueChange={(v) => v && setAssignee(v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                {members.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.full_name || m.email || 'Team member'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-aurea-ink-3">Detail</Label>
            <Textarea
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              placeholder="What needs to happen? (optional)"
              rows={4}
              maxLength={4000}
            />
          </div>
        </div>

        <div className="mt-3 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving} className="gap-1.5">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" strokeWidth={2} />}
            Create task
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
