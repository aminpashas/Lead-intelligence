'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { formatDistanceToNow } from 'date-fns'
import { Loader2, MessageSquare, Zap, Lightbulb, ListTodo, ExternalLink, Phone } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { CreateTaskDialog } from '@/components/crm/create-task-dialog'
import { useOrgStore } from '@/lib/store/use-org'
import { cn } from '@/lib/utils'

type Priority = 'low' | 'normal' | 'high' | 'urgent'

type Task = {
  id: string
  kind: string
  title: string
  detail: string | null
  ai_draft: string | null
  status: 'open' | 'claimed'
  assigned_to: string | null
  assigned_role: string | null
  priority: Priority
  due_at: string | null
  claimed_by: string | null
  lead_id: string | null
  conversation_id: string | null
  source: string
  created_at: string
}

// Higher = surfaces first. Also used to sort each section.
const PRIORITY_RANK: Record<Priority, number> = { urgent: 3, high: 2, normal: 1, low: 0 }

/** Priority pill — only rendered for above-normal urgency to avoid noise. */
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

/** Order live tasks: highest priority first, then the server's due/created sort. */
function byPriority(a: Task, b: Task): number {
  return (PRIORITY_RANK[b.priority] ?? 1) - (PRIORITY_RANK[a.priority] ?? 1)
}

const KIND_META: Record<string, { label: string; icon: typeof MessageSquare }> = {
  inbound_reply: { label: 'Reply', icon: MessageSquare },
  first_touch: { label: 'First touch', icon: Zap },
  recommendation: { label: 'Recommendation', icon: Lightbulb },
  nurture_step: { label: 'Nurture', icon: ListTodo },
  stage_automation: { label: 'Stage', icon: ListTodo },
  sla_breach_review: { label: 'SLA review', icon: ListTodo },
  call_review: { label: 'Call review', icon: MessageSquare },
  list_call: { label: 'Call', icon: Phone },
  manual: { label: 'Task', icon: ListTodo },
}

/** SLA countdown badge — red once overdue, amber when due within 5 minutes. */
function DueBadge({ dueAt, now }: { dueAt: string; now: number }) {
  const remainingMs = new Date(dueAt).getTime() - now
  const overdue = remainingMs <= 0
  const soon = !overdue && remainingMs < 5 * 60 * 1000
  const abs = Math.abs(remainingMs)
  const mins = Math.floor(abs / 60_000)
  const text = overdue
    ? `overdue ${mins < 1 ? '<1m' : `${mins}m`}`
    : mins < 1
      ? `due <1m`
      : mins < 60
        ? `due ${mins}m`
        : `due ${Math.floor(mins / 60)}h ${mins % 60}m`

  return (
    <Badge
      variant="outline"
      className={cn(
        'text-[10px] h-4 px-1.5',
        overdue
          ? 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
          : soon
            ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400'
            : 'text-aurea-ink-2'
      )}
    >
      {text}
    </Badge>
  )
}

function TaskRow({
  task,
  now,
  acting,
  onAction,
}: {
  task: Task
  now: number
  acting: boolean
  onAction: (id: string, action: 'claim' | 'complete' | 'dismiss') => void
}) {
  const meta = KIND_META[task.kind] ?? { label: task.kind, icon: ListTodo }
  const Icon = meta.icon
  const openLink = task.conversation_id
    ? `/conversations/${task.conversation_id}`
    : task.lead_id
      ? `/leads/${task.lead_id}`
      : null

  return (
    <li className="border-b border-aurea-border px-5 py-3.5 last:border-b-0">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-aurea-surface-2 border border-aurea-border">
          <Icon className="h-3.5 w-3.5 text-aurea-ink-2" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="text-[10px] h-4 px-1.5 text-aurea-ink-2">
              {meta.label}
            </Badge>
            <span className="text-[13px] font-medium text-aurea-ink">{task.title}</span>
            <PriorityBadge priority={task.priority} />
            {task.due_at && <DueBadge dueAt={task.due_at} now={now} />}
            {task.status === 'claimed' && (
              <Badge variant="outline" className="text-[10px] h-4 px-1.5 text-aurea-ink-2">
                claimed
              </Badge>
            )}
            <span className="text-[11px] text-aurea-ink-3">
              {formatDistanceToNow(new Date(task.created_at), { addSuffix: true })}
            </span>
          </div>
          {task.detail && (
            <p className="mt-1 text-[12.5px] text-aurea-ink-2 line-clamp-2">{task.detail}</p>
          )}
          {task.ai_draft && (
            <div className="mt-2 rounded-md border border-aurea-border bg-aurea-surface-2 p-2.5">
              <p className="text-[10.5px] font-semibold uppercase tracking-wide text-aurea-ink-3">
                AI draft
              </p>
              <p className="mt-0.5 text-[12.5px] text-aurea-ink-2 whitespace-pre-wrap line-clamp-4">
                {task.ai_draft}
              </p>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {openLink && (
            <Link
              href={openLink}
              className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'h-7 px-2 text-xs')}
            >
              <ExternalLink className="mr-1 h-3 w-3" />
              Open
            </Link>
          )}
          {task.status === 'open' && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={acting}
              onClick={() => onAction(task.id, 'claim')}
            >
              Claim
            </Button>
          )}
          <Button
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={acting}
            onClick={() => onAction(task.id, 'complete')}
          >
            Complete
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-aurea-ink-3"
            disabled={acting}
            onClick={() => onAction(task.id, 'dismiss')}
          >
            Dismiss
          </Button>
        </div>
      </div>
    </li>
  )
}

function Section({
  label,
  tasks,
  now,
  actingId,
  onAction,
}: {
  label: string
  tasks: Task[]
  now: number
  actingId: string | null
  onAction: (id: string, action: 'claim' | 'complete' | 'dismiss') => void
}) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-aurea-ink">{label}</h2>
        <Badge variant="outline" className="text-[10px] h-4 px-1.5 text-aurea-ink-2">
          {tasks.length}
        </Badge>
      </div>
      <Card>
        <CardContent className="p-0">
          {tasks.length === 0 ? (
            <p className="px-5 py-4 text-[13px] text-aurea-ink-3">Nothing here.</p>
          ) : (
            <ul>
              {tasks.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  now={now}
                  acting={actingId === t.id}
                  onAction={onAction}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

export function TasksList() {
  const { userProfile } = useOrgStore()
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actingId, setActingId] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/tasks?status=active&limit=100')
      if (!res.ok) throw new Error('Failed to load tasks')
      const json = await res.json()
      setTasks(json.tasks || [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load tasks')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Tick the SLA countdowns once a minute.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  const onAction = useCallback(
    async (id: string, action: 'claim' | 'complete' | 'dismiss') => {
      setActingId(id)
      try {
        const res = await fetch(`/api/tasks/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        })
        if (res.ok) await load()
      } finally {
        setActingId(null)
      }
    },
    [load]
  )

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-aurea-ink-2">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading tasks…
      </div>
    )
  }
  if (error) {
    return <p className="py-8 text-sm text-red-600">{error}</p>
  }

  const myId = userProfile?.id
  const mine = tasks
    .filter((t) => myId && (t.assigned_to === myId || t.claimed_by === myId))
    .sort(byPriority)
  const unassigned = tasks.filter((t) => !t.assigned_to && !t.claimed_by).sort(byPriority)
  const allOpen = [...tasks].sort(byPriority)

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <CreateTaskDialog onCreated={load} />
      </div>
      <Section label="Mine" tasks={mine} now={now} actingId={actingId} onAction={onAction} />
      <Section
        label="Unassigned"
        tasks={unassigned}
        now={now}
        actingId={actingId}
        onAction={onAction}
      />
      <Section label="All open" tasks={allOpen} now={now} actingId={actingId} onAction={onAction} />
    </div>
  )
}
