'use client'

import { cadenceTimeline, type TimelineEnrollment } from '@/lib/pipeline/contacted-state'

function relative(nowMs: number, targetMs: number): string {
  const day = 24 * 60 * 60 * 1000
  const diff = targetMs - nowMs
  if (diff <= 0) return 'now'
  if (diff < day) return 'today'
  const days = Math.round(diff / day)
  return days === 1 ? 'in 1d' : `in ${days}d`
}

/**
 * Day-N cadence badge for a Following Up / Engaged card:
 *   "DAY 6 · 4 of 8 · next: in 1d"  — or "REPLIED" when engaged,
 *   "NO REPLY · nurturing" when the cadence is exhausted with no reply.
 *
 * Colors follow the Aurea chip idiom from lead-card.tsx: amber = pending/
 * in-progress, primary (emerald) = a positive signal worth calling out, and
 * the neutral surface-2/ink-3/border trio = an inert/cold state.
 */
export function LeadCadenceBadge({
  enrollment,
  engaged,
  nowMs = Date.now(),
}: {
  enrollment: TimelineEnrollment | null
  engaged?: boolean
  nowMs?: number
}) {
  if (engaged) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium bg-aurea-primary/10 text-aurea-primary border border-aurea-primary/20">
        REPLIED
      </span>
    )
  }
  const tl = cadenceTimeline({ enrollment, now: nowMs })
  if (!tl) return null
  if (tl.exhausted) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border">
        NO REPLY · nurturing
      </span>
    )
  }
  const next = tl.nextTouchAtMs ? ` · next: ${relative(nowMs, tl.nextTouchAtMs)}` : ''
  return (
    <span className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium bg-aurea-amber/10 text-aurea-amber border border-aurea-amber/20">
      DAY {tl.dayN} · {tl.stepIndex + 1} of {tl.totalSteps}{next}
    </span>
  )
}
