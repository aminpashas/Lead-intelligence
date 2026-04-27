'use client'

import { useEffect, useState, useCallback } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ShieldAlert, ShieldCheck, ShieldQuestion, AlertTriangle, Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  type AgentGrade,
  STATUS_LABELS,
  STATUS_DESCRIPTIONS,
} from '@/lib/agents/grading'
import { KPI_LABELS, formatKpiValue, KPI_UNITS } from '@/lib/agents/kpi-status'

type CurrentStatusResponse = {
  status: {
    status: AgentGrade
    since: string
    consecutive_red_periods: number
    consecutive_green_periods: number
  } | null
  latest_review: {
    id: string
    period_start: string
    period_end: string
    overall_grade: AgentGrade
    reasons: Array<{ kpi_name: string; severity: 'warning' | 'critical'; value: number | null; target: number | null }>
    notes: string | null
    reviewed_by: string | null
    reviewed_at: string
  } | null
}

const PILL_STYLES: Record<AgentGrade, { bg: string; text: string; icon: typeof ShieldCheck }> = {
  green: {
    bg: 'bg-emerald-500/15 border-emerald-500/25',
    text: 'text-emerald-700 dark:text-emerald-400',
    icon: ShieldCheck,
  },
  yellow: {
    bg: 'bg-amber-500/15 border-amber-500/25',
    text: 'text-amber-700 dark:text-amber-400',
    icon: AlertTriangle,
  },
  red: {
    bg: 'bg-rose-500/15 border-rose-500/25',
    text: 'text-rose-700 dark:text-rose-400',
    icon: ShieldAlert,
  },
  probation: {
    bg: 'bg-rose-700/20 border-rose-700/30',
    text: 'text-rose-800 dark:text-rose-300',
    icon: ShieldAlert,
  },
  unrated: {
    bg: 'bg-slate-500/10 border-slate-500/20',
    text: 'text-slate-600 dark:text-slate-400',
    icon: ShieldQuestion,
  },
}

export function AgentStatusPill({
  agentId,
  canOverride,
  onOverrideClick,
}: {
  agentId: string
  canOverride: boolean
  onOverrideClick: () => void
}) {
  const [data, setData] = useState<CurrentStatusResponse | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents/${agentId}/reviews/current`)
      if (!res.ok) throw new Error('failed')
      const json = (await res.json()) as CurrentStatusResponse
      setData(json)
    } catch {
      setData({ status: null, latest_review: null })
    } finally {
      setLoading(false)
    }
  }, [agentId])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) return <Skeleton className="h-6 w-24" />
  if (!data?.status) {
    return (
      <Badge variant="outline" className={cn(PILL_STYLES.unrated.bg, PILL_STYLES.unrated.text)}>
        Unrated
      </Badge>
    )
  }

  const grade = data.status.status
  const style = PILL_STYLES[grade]
  const Icon = style.icon
  const review = data.latest_review

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Badge
          variant="outline"
          className={cn('gap-1.5 px-2 py-0.5 text-xs font-medium', style.bg, style.text)}
          title={STATUS_DESCRIPTIONS[grade]}
        >
          <Icon className="h-3 w-3" />
          {STATUS_LABELS[grade]}
          {grade === 'probation' && ` (${data.status.consecutive_red_periods}w red)`}
          {grade === 'green' && data.status.consecutive_green_periods > 1 && ` · ${data.status.consecutive_green_periods}w streak`}
        </Badge>
        {canOverride && review && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={onOverrideClick}
            aria-label="Manual override"
          >
            <Pencil className="h-3 w-3 mr-1" /> Override
          </Button>
        )}
      </div>
      {review && review.reasons.length > 0 && grade !== 'green' && grade !== 'unrated' && (
        <div className="text-[11px] text-muted-foreground space-y-0.5">
          <div className="font-medium">
            Latest review · {new Date(review.reviewed_at).toLocaleDateString()}
          </div>
          {review.reasons.slice(0, 3).map((r) => (
            <div key={r.kpi_name} className="flex items-center gap-1">
              <span
                className={cn(
                  'inline-block w-1.5 h-1.5 rounded-full',
                  r.severity === 'critical' ? 'bg-rose-500' : 'bg-amber-500'
                )}
              />
              <span>
                {KPI_LABELS[r.kpi_name] ?? r.kpi_name}:{' '}
                <span className="tabular-nums">
                  {formatKpiValue(r.value, KPI_UNITS[r.kpi_name])}
                </span>{' '}
                vs target{' '}
                <span className="tabular-nums">
                  {formatKpiValue(r.target, KPI_UNITS[r.kpi_name])}
                </span>
              </span>
            </div>
          ))}
          {review.reasons.length > 3 && (
            <div className="text-[10px] text-muted-foreground">
              +{review.reasons.length - 3} more
            </div>
          )}
        </div>
      )}
    </div>
  )
}
