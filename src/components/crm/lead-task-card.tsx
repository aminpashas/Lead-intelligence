'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatDistanceToNow } from 'date-fns'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { isPossiblyMoot } from '@/lib/tasks/moot'
import { CheckCircle2, Clock, X, AlarmClock, ChevronDown, AlertTriangle } from 'lucide-react'

type Priority = 'low' | 'normal' | 'high' | 'urgent'

/** The columns the card renders — a subset of human_tasks. */
export type LeadTask = {
  id: string
  kind: string
  title: string
  detail: string | null
  status: 'open' | 'claimed'
  priority: Priority
  due_at: string | null
  assigned_to: string | null
  reviewed_at: string | null
  created_at: string
}

type TeamMember = { id: string; full_name: string | null; email: string; role: string }

const PRIORITY_RANK: Record<Priority, number> = { urgent: 3, high: 2, normal: 1, low: 0 }

const SNOOZE_PRESETS: { label: string; days: number }[] = [
  { label: 'Tomorrow', days: 1 },
  { label: '3 days', days: 3 },
  { label: '1 week', days: 7 },
  { label: '2 weeks', days: 14 },
]

function PriorityBadge({ priority }: { priority: Priority }) {
  if (priority !== 'high' && priority !== 'urgent') return null
  return (
    <Badge
      variant="outline"
      className={cn(
        'text-[10px] h-4 px-1.5 capitalize',
        priority === 'urgent'
          ? 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
          : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400'
      )}
    >
      {priority}
    </Badge>
  )
}

function DueChip({ dueAt }: { dueAt: string }) {
  const overdue = new Date(dueAt).getTime() < Date.now()
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-[11px]',
        overdue ? 'text-red-600 dark:text-red-400' : 'text-aurea-ink-3'
      )}
    >
      <Clock className="h-3 w-3" strokeWidth={1.75} />
      {overdue ? 'Overdue ' : 'Due '}
      {formatDistanceToNow(new Date(dueAt), { addSuffix: !overdue })}
    </span>
  )
}

/** Client-side ordering: overdue first, then future-due asc, then priority, then newest. */
function sortTasks(tasks: LeadTask[]): LeadTask[] {
  return [...tasks].sort((a, b) => {
    const ad = a.due_at ? new Date(a.due_at).getTime() : null
    const bd = b.due_at ? new Date(b.due_at).getTime() : null
    if (ad !== null && bd !== null) return ad - bd
    if (ad !== null) return -1
    if (bd !== null) return 1
    if (PRIORITY_RANK[a.priority] !== PRIORITY_RANK[b.priority])
      return PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  })
}

export function LeadTaskCard({
  leadId: _leadId,
  initialTasks,
  teamMembers,
  lastContactedAt,
}: {
  leadId: string
  initialTasks: LeadTask[]
  teamMembers: TeamMember[]
  lastContactedAt: string | null
}) {
  const router = useRouter()
  const [tasks, setTasks] = useState<LeadTask[]>(initialTasks)
  const [busy, setBusy] = useState<Record<string, boolean>>({})

  const nameFor = useMemo(() => {
    const map = new Map(teamMembers.map((m) => [m.id, m.full_name || m.email]))
    return (id: string | null) => (id ? map.get(id) ?? 'Assigned' : 'Unassigned')
  }, [teamMembers])

  const sorted = useMemo(() => sortTasks(tasks), [tasks])

  if (tasks.length === 0) return null

  async function patch(id: string, body: Record<string, unknown>) {
    const res = await fetch(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      throw new Error(j.error || 'Update failed')
    }
    return res
  }

  // Optimistically apply `optimistic` to the row; on failure restore `prev`.
  async function run(
    id: string,
    body: Record<string, unknown>,
    optimistic: (t: LeadTask) => LeadTask | null
  ) {
    const prev = tasks
    setBusy((b) => ({ ...b, [id]: true }))
    setTasks((ts) =>
      ts.flatMap((t) => {
        if (t.id !== id) return [t]
        const next = optimistic(t)
        return next ? [next] : []
      })
    )
    try {
      await patch(id, body)
      router.refresh()
    } catch (e) {
      setTasks(prev)
      toast.error(e instanceof Error ? e.message : 'Update failed')
    } finally {
      setBusy((b) => ({ ...b, [id]: false }))
    }
  }

  const nowIso = () => new Date().toISOString()

  return (
    <div className="border-b border-aurea-border bg-aurea-surface-2/40 px-4 py-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-aurea-ink-3">
        <AlarmClock className="h-3.5 w-3.5" strokeWidth={1.75} />
        {tasks.length === 1 ? '1 open task' : `${tasks.length} open tasks`}
        {initialTasks.length >= 20 && (
          <a href="/tasks" className="ml-1 normal-case text-aurea-ink-3 underline">
            more may exist — view all
          </a>
        )}
      </div>
      <ul className="space-y-2">
        {sorted.map((t) => {
          const moot = isPossiblyMoot(t, lastContactedAt)
          const isBusy = !!busy[t.id]
          return (
            <li
              key={t.id}
              className={cn(
                'rounded-md border bg-aurea-surface px-3 py-2',
                moot ? 'border-l-2 border-l-amber-500 border-aurea-border' : 'border-aurea-border'
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] text-aurea-ink">{t.title}</span>
                    <PriorityBadge priority={t.priority} />
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-aurea-ink-3">
                    {t.due_at && <DueChip dueAt={t.due_at} />}
                    <span>{nameFor(t.assigned_to)}</span>
                    <span>
                      {t.reviewed_at
                        ? `Reviewed ${formatDistanceToNow(new Date(t.reviewed_at), { addSuffix: true })}`
                        : 'Never reviewed'}
                    </span>
                  </div>
                  {moot && (
                    <div className="mt-1 flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400">
                      <AlertTriangle className="h-3 w-3" strokeWidth={1.75} />
                      Lead was contacted since this was created — still needed?
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={isBusy}
                    className="h-7 px-2 text-[11px]"
                    onClick={() => run(t.id, { action: 'review' }, (x) => ({ ...x, reviewed_at: nowIso() }))}
                  >
                    Still relevant
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      disabled={isBusy}
                      className="inline-flex h-7 cursor-pointer items-center gap-0.5 rounded-md px-2 text-[11px] text-aurea-ink transition-colors hover:bg-aurea-surface-2 disabled:pointer-events-none disabled:opacity-50"
                    >
                      Snooze <ChevronDown className="h-3 w-3" strokeWidth={1.75} />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {SNOOZE_PRESETS.map((p) => (
                        <DropdownMenuItem
                          key={p.days}
                          onClick={() =>
                            run(
                              t.id,
                              { action: 'snooze', snooze_days: p.days },
                              (x) => ({
                                ...x,
                                reviewed_at: nowIso(),
                                due_at: new Date(Date.now() + p.days * 864e5).toISOString(),
                              })
                            )
                          }
                        >
                          {p.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={isBusy}
                    className="h-7 px-2 text-[11px] text-aurea-ink-2"
                    onClick={() => run(t.id, { action: 'complete' }, () => null)}
                  >
                    <CheckCircle2 className="mr-1 h-3.5 w-3.5" strokeWidth={1.75} /> Done
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={isBusy}
                    aria-label="Dismiss task"
                    className="h-7 w-7 p-0 text-aurea-ink-3"
                    onClick={() => run(t.id, { action: 'dismiss' }, () => null)}
                  >
                    <X className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </Button>
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
