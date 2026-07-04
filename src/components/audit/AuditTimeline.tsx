'use client'

import { useEffect, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { Bot, User, Cog, Clock, Webhook, Loader2, History } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { ActorType, TimelineRow } from '@/lib/audit/types'

const ACTOR_META: Record<
  ActorType,
  { label: string; icon: typeof Bot; badgeClass: string }
> = {
  ai_agent: {
    label: 'AI',
    icon: Bot,
    badgeClass: 'bg-aurea-primary/10 text-aurea-primary border border-aurea-primary/20',
  },
  user: {
    label: 'Staff',
    icon: User,
    badgeClass: 'bg-aurea-surface-2 text-aurea-ink border border-aurea-border',
  },
  system: {
    label: 'System',
    icon: Cog,
    badgeClass: 'bg-aurea-surface-2 text-aurea-ink-2 border border-aurea-border',
  },
  cron: {
    label: 'Scheduled',
    icon: Clock,
    badgeClass: 'bg-aurea-surface-2 text-aurea-ink-2 border border-aurea-border',
  },
  webhook: {
    label: 'Webhook',
    icon: Webhook,
    badgeClass: 'bg-aurea-surface-2 text-aurea-ink-2 border border-aurea-border',
  },
}

function actorMetaFor(actorType: ActorType) {
  return ACTOR_META[actorType] ?? ACTOR_META.system
}

function autonomyNote(row: TimelineRow): string | null {
  if (!row.ai) return null
  if (row.ai.autonomous === true) return 'autonomous'
  if (row.ai.autonomous === false && row.ai.approved_by) return `approved by ${row.ai.approved_by}`
  return null
}

function TimelineRowItem({ row }: { row: TimelineRow }) {
  const meta = actorMetaFor(row.actorType)
  const Icon = meta.icon
  const badgeLabel =
    row.actorType === 'ai_agent' && row.ai?.agent_role
      ? `AI ${row.ai.agent_role}`
      : meta.label
  const autonomy = autonomyNote(row)

  return (
    <li className="flex items-start gap-3 border-b border-aurea-border px-5 py-3.5 last:border-b-0">
      <span
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${meta.badgeClass}`}
      >
        <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge className={`text-[10px] h-4 px-1.5 ${meta.badgeClass}`}>{badgeLabel}</Badge>
          <span className="text-[13px] font-medium text-aurea-ink">{row.action}</span>
          {row.actorLabel && (
            <span className="text-[12px] text-aurea-ink-3">by {row.actorLabel}</span>
          )}
          {autonomy && (
            <Badge variant="outline" className="text-[10px] h-4 px-1.5 text-aurea-ink-2">
              {autonomy}
            </Badge>
          )}
          {row.severity !== 'info' && (
            <Badge
              className={`text-[10px] h-4 px-1.5 ${
                row.severity === 'critical'
                  ? 'bg-aurea-rose/10 text-aurea-rose border border-aurea-rose/20'
                  : 'bg-aurea-amber/10 text-aurea-amber border border-aurea-amber/20'
              }`}
            >
              {row.severity}
            </Badge>
          )}
        </div>

        {row.changedFields.length > 0 && (
          <p className="mt-1 text-[12px] text-aurea-ink-3">
            changed: {row.changedFields.join(', ')}
          </p>
        )}

        <p className="mt-1 font-mono text-[11px] tabular-nums text-aurea-ink-3">
          {new Date(row.occurredAt).toLocaleString()} ·{' '}
          {formatDistanceToNow(new Date(row.occurredAt), { addSuffix: true })}
        </p>
      </div>
    </li>
  )
}

export function AuditTimeline({ query }: { query?: string }) {
  const [rows, setRows] = useState<TimelineRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`/api/audit?${query ?? ''}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        setRows(d.rows ?? [])
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load audit history.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [query])

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center gap-2 py-10 text-sm text-aurea-ink-3">
          <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
          Loading audit history…
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-aurea-rose">{error}</CardContent>
      </Card>
    )
  }

  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center py-10 text-center text-sm text-aurea-ink-3">
          <History className="mb-2 h-8 w-8 text-aurea-ink-3" strokeWidth={1.75} />
          No audit history yet.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="aurea-card overflow-hidden">
      <ol>
        {rows.map((row) => (
          <TimelineRowItem key={row.id} row={row} />
        ))}
      </ol>
    </div>
  )
}
