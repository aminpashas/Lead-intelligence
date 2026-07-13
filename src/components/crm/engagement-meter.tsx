'use client'

/**
 * Engagement meter — renders `leads.engagement_temperature` + `engagement_score`
 * (the behavioral hot/warm/cooling/cold/new signal maintained by
 * cron/engagement-sweep). This is deliberately NOT the AI quality grade
 * (ai_score/ai_qualification) — see src/lib/engagement/temperature.ts.
 *
 * A `null` temperature means the sweep hasn't graded the lead yet (pre-backfill
 * rows) — render a quiet placeholder, never a fake "Cold".
 */

import type { EngagementTemperature } from '@/lib/engagement/temperature'
import { TEMPERATURE_META } from '@/lib/engagement/temperature'

const BAND_STYLES: Record<EngagementTemperature, { chip: string; dot: string; fill: string }> = {
  hot: {
    chip: 'bg-aurea-rose/10 text-aurea-rose border border-aurea-rose/20',
    dot: 'bg-aurea-rose',
    fill: 'bg-aurea-rose',
  },
  warm: {
    chip: 'bg-aurea-amber/10 text-aurea-amber border border-aurea-amber/20',
    dot: 'bg-aurea-amber',
    fill: 'bg-aurea-amber',
  },
  cooling: {
    chip: 'bg-aurea-surface-2 text-aurea-ink-2 border border-aurea-border',
    dot: 'bg-aurea-ink-2',
    fill: 'bg-aurea-ink-2',
  },
  new: {
    chip: 'bg-aurea-surface-2 text-aurea-ink-2 border border-aurea-border',
    dot: 'bg-aurea-ink-3',
    fill: 'bg-aurea-ink-3',
  },
  cold: {
    chip: 'bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border',
    dot: 'bg-aurea-ink-3/50',
    fill: 'bg-aurea-ink-3/50',
  },
}

function isTemperature(v: string | null | undefined): v is EngagementTemperature {
  return !!v && v in BAND_STYLES
}

/** Compact chip (dot + label) for dense surfaces like the pipeline card. */
export function EngagementTempChip({
  temperature,
}: {
  temperature: string | null | undefined
}) {
  if (!isTemperature(temperature)) return null
  const styles = BAND_STYLES[temperature]
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium ${styles.chip}`}
      title="Engagement temperature"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${styles.dot}`} />
      {TEMPERATURE_META[temperature].label}
    </span>
  )
}

export function EngagementMeter({
  temperature,
  score,
}: {
  temperature: string | null | undefined
  score: number | null | undefined
}) {
  if (!isTemperature(temperature)) {
    return <span className="font-mono text-[11px] text-aurea-ink-3">—</span>
  }
  const styles = BAND_STYLES[temperature]
  const meta = TEMPERATURE_META[temperature]
  const pct = Math.max(0, Math.min(100, score ?? 0))

  return (
    <div className="flex flex-col gap-1">
      <span
        className={`inline-flex w-fit items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium ${styles.chip}`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${styles.dot}`} />
        {meta.label}
        <span className="font-mono tabular-nums">{score ?? 0}</span>
      </span>
      <div className="h-[3px] w-16 overflow-hidden rounded-full bg-aurea-surface-2">
        <div className={`h-full rounded-full ${styles.fill}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
