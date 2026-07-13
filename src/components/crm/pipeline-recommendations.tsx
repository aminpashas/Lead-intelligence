'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Sparkles, Flame, MessageSquare, Send, RefreshCw, X,
  ChevronDown, ChevronRight, Loader2, ArrowRight, MoveRight, Users, Clock,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { Recommendation, RecommendationKind } from '@/lib/pipeline/recommendations'
import { RecommendationCohortSheet } from './recommendation-cohort-sheet'

const DISMISS_KEY = 'li:pipeline-recos:dismissed'

/** "$52,340" (whole dollars) up to $1M, then compact "$1.2M" so the pill never
 *  blows out the card header on big books. */
function formatEstValue(v: number): string {
  if (v >= 1_000_000) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(v)
  }
  return `$${Math.round(v).toLocaleString()}`
}

const KIND_ICON: Record<RecommendationKind, typeof Flame> = {
  follow_up_deliberating: Clock,
  strike_hot: Flame,
  follow_up: MessageSquare,
  start_outreach: Send,
  re_engage: RefreshCw,
  advance_stage: MoveRight,
}

/** Persisted rows can carry 'analyst_insight' (LLM analyst, C2) — Sparkles. */
function kindIcon(kind: Recommendation['kind']): typeof Flame {
  return KIND_ICON[kind as RecommendationKind] ?? Sparkles
}

/** Accent by urgency tier — high-priority recs read hotter. */
function tier(priority: number): { ring: string; icon: string; pill: string } {
  if (priority >= 70)
    return {
      ring: 'border-aurea-rose/40',
      icon: 'bg-aurea-rose/10 text-aurea-rose',
      pill: 'bg-aurea-rose/10 text-aurea-rose',
    }
  if (priority >= 45)
    return {
      ring: 'border-aurea-amber/40',
      icon: 'bg-aurea-amber/10 text-aurea-amber',
      pill: 'bg-aurea-amber/10 text-aurea-amber',
    }
  return {
    ring: 'border-aurea-border',
    icon: 'bg-aurea-primary/10 text-aurea-primary',
    pill: 'bg-aurea-surface-2 text-aurea-ink-2',
  }
}

export function PipelineRecommendations({
  recommendations,
}: {
  recommendations: Recommendation[]
}) {
  const router = useRouter()
  const [collapsed, setCollapsed] = useState(false)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [applyingId, setApplyingId] = useState<string | null>(null)
  const [hydrated, setHydrated] = useState(false)
  // The recommendation whose full lead cohort is open in the drill-down sheet.
  const [cohortRec, setCohortRec] = useState<Recommendation | null>(null)

  // Dismissals persist locally (instant, works for live-computed recs with no
  // DB row yet) AND server-side (C2: the persisted row is stamped 'dismissed'
  // so it stays gone across devices and enters the outcome control group).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DISMISS_KEY)
      if (raw) setDismissed(new Set(JSON.parse(raw) as string[]))
    } catch {
      /* ignore malformed storage */
    }
    setHydrated(true)
  }, [])

  const visible = useMemo(
    () => recommendations.filter((r) => !dismissed.has(r.id)),
    [recommendations, dismissed]
  )

  function dismiss(id: string, notifyServer = false) {
    // Optimistic local removal — the card disappears immediately.
    setDismissed((prev) => {
      const next = new Set(prev).add(id)
      try {
        localStorage.setItem(DISMISS_KEY, JSON.stringify([...next]))
      } catch {
        /* ignore */
      }
      return next
    })
    // Best-effort server stamp (id = dedupe_key; no open row is fine). Only on
    // an explicit user dismissal — apply paths stamp their own status.
    if (notifyServer) {
      fetch(`/api/pipeline/recommendations/${encodeURIComponent(id)}/dismiss`, {
        method: 'POST',
      }).catch(() => {
        /* local dismissal stands; the row ages out via expires_at */
      })
    }
  }

  async function apply(rec: Recommendation, autoApply = false) {
    const a = rec.action

    // Auto-apply moves leads with no review step — confirm before mutating.
    if (autoApply) {
      const ok = window.confirm(
        `Move ${rec.leadCount.toLocaleString()} leads now? This changes their pipeline stage immediately — there's no review step.`
      )
      if (!ok) return
    }

    setApplyingId(rec.id)
    try {
      const res = await fetch('/api/pipeline/recommendations/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          segmentName: a.segmentName,
          actionType: a.type,
          channel: a.type === 'broadcast' ? a.channel : undefined,
          toStageSlug: a.type === 'bulk_stage' ? a.toStageSlug : undefined,
          criteria: a.criteria,
          autoApply: autoApply && a.type === 'bulk_stage' ? true : undefined,
          // C2: lets the server stamp the persisted row 'applied'.
          dedupeKey: rec.id,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || 'Could not prepare this recommendation')
      }

      // D2 human lane: the apply was routed to the task queue — nothing to
      // redirect to. The server stamped the row 'applied'; drop the card.
      if (data.taskCreated) {
        toast.success('Routed to your team’s task queue for review.')
        dismiss(rec.id)
        router.refresh()
        setApplyingId(null)
        return
      }

      // Auto-applied stage move: nothing to redirect to — refresh the board so
      // the moved leads leave this stage and the recommendation recomputes.
      if (data.autoApplied) {
        const capped = data.capped
          ? ` (capped — ${(data.total ?? 0).toLocaleString()} matched, move the rest again)`
          : ''
        toast.success(`Moved ${(data.moved ?? 0).toLocaleString()} leads to ${data.toStageName}${capped}.`)
        dismiss(rec.id)
        router.refresh()
        setApplyingId(null)
        return
      }

      if (!data.redirect) throw new Error('Could not prepare this recommendation')
      toast.success(`Segment ready — ${(data.leadCount ?? 0).toLocaleString()} leads. Review before sending.`)
      router.push(data.redirect)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Something went wrong')
      setApplyingId(null)
    }
  }

  // Avoid an SSR/client flash: render nothing until we've read dismissals.
  if (!hydrated || visible.length === 0) return null

  return (
    <section className="mb-6 rounded-xl border border-aurea-border bg-aurea-surface">
      <header className="flex items-center justify-between px-4 py-3">
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-2 text-left"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-aurea-primary/10 text-aurea-primary">
            <Sparkles className="h-4 w-4" />
          </span>
          <span className="text-[14px] font-medium text-aurea-ink">Recommendations</span>
          <span className="rounded-full bg-aurea-surface-2 px-2 py-0.5 text-[11px] font-medium text-aurea-ink-2">
            {visible.length}
          </span>
          {collapsed ? (
            <ChevronRight className="h-4 w-4 text-aurea-ink-2" />
          ) : (
            <ChevronDown className="h-4 w-4 text-aurea-ink-2" />
          )}
        </button>
        <span className="hidden text-[12px] text-aurea-ink-2 sm:inline">
          AI suggestions to work your pipeline — you review before anything sends
        </span>
      </header>

      {!collapsed && (
        <div className="flex gap-3 overflow-x-auto px-4 pb-4">
          {visible.map((rec) => {
            const Icon = kindIcon(rec.kind)
            const t = tier(rec.priority)
            const busy = applyingId === rec.id
            return (
              <article
                key={rec.id}
                className={cn(
                  'flex min-w-[300px] max-w-[340px] flex-col rounded-xl border bg-aurea-bg p-4',
                  t.ring
                )}
              >
                <div className="mb-2 flex items-start justify-between gap-2">
                  <span className={cn('flex h-8 w-8 items-center justify-center rounded-lg', t.icon)}>
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="flex flex-wrap items-center justify-end gap-1.5">
                    {rec.expectedValueUsd != null && rec.expectedValueUsd > 0 && (
                      <span
                        className="rounded-full bg-aurea-surface-2 px-2 py-0.5 text-[10px] font-semibold text-aurea-ink-2"
                        title="Estimated pipeline value: sum of each lead's close probability × treatment value"
                      >
                        {formatEstValue(rec.expectedValueUsd)} est. value
                      </span>
                    )}
                    <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide', t.pill)}>
                      {rec.leadCount.toLocaleString()} leads
                    </span>
                    <button
                      onClick={() => dismiss(rec.id, true)}
                      className="text-aurea-ink-2 transition-colors hover:text-aurea-ink"
                      aria-label="Dismiss recommendation"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                {/* Card body opens the full lead cohort — "show me the leads". */}
                <button
                  type="button"
                  onClick={() => setCohortRec(rec)}
                  className="mb-3 flex-1 text-left"
                >
                  <h3 className="mb-1 text-[13.5px] font-semibold leading-snug text-aurea-ink">
                    {rec.title}
                  </h3>
                  <p className="text-[12px] leading-relaxed text-aurea-ink-2">
                    {rec.detail}
                  </p>
                </button>

                {/* Open the drill-down sheet listing every targeted lead. */}
                <button
                  type="button"
                  onClick={() => setCohortRec(rec)}
                  className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-aurea-primary transition-colors hover:text-aurea-ink"
                >
                  <Users className="h-3.5 w-3.5" />
                  Show {rec.leadCount.toLocaleString()} leads
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>

                <Button
                  size="sm"
                  onClick={() => apply(rec)}
                  disabled={busy}
                  className="w-full justify-center gap-1.5"
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <>
                      {rec.action.type === 'bulk_stage' ? 'Review & move' : rec.cta}
                      <ArrowRight className="h-3.5 w-3.5" />
                    </>
                  )}
                </Button>

                {/* Stage moves can be applied directly — a stage change sends
                    nothing, so it skips the review hand-off (still confirmed). */}
                {rec.action.type === 'bulk_stage' && (
                  <button
                    onClick={() => apply(rec, true)}
                    disabled={busy}
                    className="mt-1.5 w-full text-center text-[11px] font-medium text-aurea-ink-2 transition-colors hover:text-aurea-ink disabled:opacity-50"
                  >
                    Move {rec.leadCount.toLocaleString()} now, skip review
                  </button>
                )}
              </article>
            )
          })}
        </div>
      )}

      {/* Full lead cohort for the open card — list, page, and click through to
          work each lead; the primary action mirrors the card's button. */}
      <RecommendationCohortSheet
        rec={cohortRec}
        onClose={() => setCohortRec(null)}
        onApply={(rec) => apply(rec)}
        applying={cohortRec != null && applyingId === cohortRec.id}
      />
    </section>
  )
}
