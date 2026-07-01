'use client'

import { useEffect, useState } from 'react'
import { Target } from 'lucide-react'

type PaceStatus = 'green' | 'yellow' | 'red' | 'no_data'

type GoalProgress = {
  id: string
  metric: string
  label: string | null
  target_value: number
  period_end: string
  actual: number
  progress: { pct: number; expectedPct: number; paceStatus: PaceStatus; onPace: boolean }
}

const METRIC_LABEL: Record<string, string> = {
  pipeline_value: 'Pipeline value',
  conversions: 'Conversions',
  revenue: 'Revenue',
  bookings: 'Bookings',
  qualification_rate: 'Qualification rate',
}

const BAR: Record<PaceStatus, string> = {
  green: 'bg-aurea-primary',
  yellow: 'bg-aurea-amber',
  red: 'bg-aurea-rose',
  no_data: 'bg-aurea-surface-2',
}

function fmt(metric: string, n: number): string {
  if (metric === 'pipeline_value' || metric === 'revenue') return `$${Math.round(n).toLocaleString()}`
  if (metric === 'qualification_rate') return `${Math.round(n)}%`
  return Math.round(n).toLocaleString()
}

export function OrgGoalsCard() {
  const [goals, setGoals] = useState<GoalProgress[] | null>(null)

  useEffect(() => {
    let active = true
    fetch('/api/org/goals/progress')
      .then((r) => (r.ok ? r.json() : { goals: [] }))
      .then((d) => {
        if (active) setGoals(d.goals ?? [])
      })
      .catch(() => active && setGoals([]))
    return () => {
      active = false
    }
  }, [])

  // Render nothing until loaded, and nothing if the org has no goals (feature unused).
  if (!goals || goals.length === 0) return null

  return (
    <div className="aurea-card overflow-hidden">
      <div className="flex items-center gap-2 border-b border-aurea-border px-5 py-4">
        <Target className="h-[17px] w-[17px] text-aurea-ink-3 shrink-0" strokeWidth={1.75} />
        <h2 className="aurea-display text-[18px] leading-tight text-aurea-ink">Goals — on pace?</h2>
      </div>
      <div className="space-y-4 px-5 py-4">
        {goals.map((g) => {
          const pct = Math.max(0, Math.min(100, g.progress.pct))
          return (
            <div key={g.id} className="space-y-1">
              <div className="flex justify-between text-[12px]">
                <span className="font-medium text-aurea-ink">
                  {g.label || METRIC_LABEL[g.metric] || g.metric}
                </span>
                <span className="font-mono tabular-nums text-aurea-ink-3">
                  {fmt(g.metric, g.actual)} / {fmt(g.metric, g.target_value)}
                </span>
              </div>
              <div className="relative h-[3px] w-full overflow-hidden rounded-full bg-aurea-surface-2">
                <div
                  className={`absolute inset-y-0 left-0 rounded-full ${BAR[g.progress.paceStatus]}`}
                  style={{ width: `${pct}%` }}
                />
                {/* expected-pace marker */}
                <div
                  className="absolute inset-y-0 w-0.5 bg-aurea-ink/30"
                  style={{ left: `${Math.max(0, Math.min(100, g.progress.expectedPct))}%` }}
                  title="Expected pace"
                />
              </div>
              <div className="text-[11px] text-aurea-ink-3">
                {g.progress.paceStatus === 'no_data'
                  ? 'No target set'
                  : g.progress.onPace
                    ? 'On pace'
                    : `Behind pace (${Math.round(pct)}% vs ${Math.round(g.progress.expectedPct)}% expected)`}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
