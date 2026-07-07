'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Sparkles, Flame, MessageSquare, Send, RefreshCw, X,
  ChevronDown, ChevronRight, Loader2, ArrowRight, MoveRight,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { Recommendation, RecommendationKind } from '@/lib/pipeline/recommendations'

const DISMISS_KEY = 'li:pipeline-recos:dismissed'

const KIND_ICON: Record<RecommendationKind, typeof Flame> = {
  strike_hot: Flame,
  follow_up: MessageSquare,
  start_outreach: Send,
  re_engage: RefreshCw,
  advance_stage: MoveRight,
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

  // Dismissals persist locally so a recommendation the user waved off doesn't
  // reappear on every navigation. (Server-side dismissal is a future refinement.)
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

  function dismiss(id: string) {
    setDismissed((prev) => {
      const next = new Set(prev).add(id)
      try {
        localStorage.setItem(DISMISS_KEY, JSON.stringify([...next]))
      } catch {
        /* ignore */
      }
      return next
    })
  }

  async function apply(rec: Recommendation) {
    setApplyingId(rec.id)
    try {
      const a = rec.action
      const res = await fetch('/api/pipeline/recommendations/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          segmentName: a.segmentName,
          actionType: a.type,
          channel: a.type === 'broadcast' ? a.channel : undefined,
          toStageSlug: a.type === 'bulk_stage' ? a.toStageSlug : undefined,
          criteria: a.criteria,
        }),
      })
      const data = await res.json()
      if (!res.ok || !data.redirect) {
        throw new Error(data.error || 'Could not prepare this recommendation')
      }
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
            const Icon = KIND_ICON[rec.kind]
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
                  <div className="flex items-center gap-2">
                    <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide', t.pill)}>
                      {rec.leadCount.toLocaleString()} leads
                    </span>
                    <button
                      onClick={() => dismiss(rec.id)}
                      className="text-aurea-ink-2 transition-colors hover:text-aurea-ink"
                      aria-label="Dismiss recommendation"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                <h3 className="mb-1 text-[13.5px] font-semibold leading-snug text-aurea-ink">
                  {rec.title}
                </h3>
                <p className="mb-4 flex-1 text-[12px] leading-relaxed text-aurea-ink-2">
                  {rec.detail}
                </p>
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
                      {rec.cta}
                      <ArrowRight className="h-3.5 w-3.5" />
                    </>
                  )}
                </Button>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
