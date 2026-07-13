'use client'

/**
 * The full lead cohort behind a Pipeline recommendation card — a right-side
 * slide-over that lists EVERY lead the recommendation targets (paged), so the
 * user can open any of them and work it. This is the "show me the 125 leads"
 * surface; the inline card only advertises the count.
 *
 * Read path:  POST /api/pipeline/recommendations/cohort (paginated, count-exact
 * with the card because both resolve the rec's own `criteria`).
 *
 * Act path:   the card's own action (Review & move / Send…) is surfaced here as
 * a primary button so the user can act on the whole cohort without closing the
 * sheet. The parent owns that handler (`onApply`) — nothing is sent from here.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { formatDistanceToNow } from 'date-fns'
import { toast } from 'sonner'
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@/components/ui/sheet'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { AlertTriangle, ArrowRight, Loader2, MoveRight } from 'lucide-react'
import type { Recommendation } from '@/lib/pipeline/recommendations'
import type {
  RecommendationCohortLead,
  RecommendationCohortPage,
} from '@/app/api/pipeline/recommendations/cohort/route'

const PAGE_SIZE = 50

export function RecommendationCohortSheet({
  rec,
  onClose,
  onApply,
  applying,
}: {
  /** Recommendation whose cohort to show — null keeps the sheet closed. */
  rec: Recommendation | null
  onClose: () => void
  /** Run the recommendation's action (same handler as the card button). */
  onApply: (rec: Recommendation) => void
  /** True while `onApply` is in flight for this rec. */
  applying: boolean
}) {
  const [leads, setLeads] = useState<RecommendationCohortLead[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchPage = useCallback(
    async (criteria: Recommendation['action']['criteria'], offset: number) => {
      const res = await fetch('/api/pipeline/recommendations/cohort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ criteria, limit: PAGE_SIZE, offset }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`)
      return body as RecommendationCohortPage
    },
    []
  )

  // (Re)load from the top whenever a different recommendation opens the sheet.
  useEffect(() => {
    if (!rec) return
    let cancelled = false
    setLeads([])
    setTotal(0)
    setError(null)
    setLoading(true)
    fetchPage(rec.action.criteria, 0)
      .then((page) => {
        if (cancelled) return
        setLeads(page.leads)
        setTotal(page.total)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load leads')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [rec, fetchPage])

  const loadMore = async () => {
    if (!rec) return
    setLoadingMore(true)
    try {
      const page = await fetchPage(rec.action.criteria, leads.length)
      setLeads((prev) => [...prev, ...page.leads])
      setTotal(page.total)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load more')
    } finally {
      setLoadingMore(false)
    }
  }

  const isStageMove = rec?.action.type === 'bulk_stage'
  const actionLabel = isStageMove ? 'Review & move all' : rec?.cta ?? 'Review'

  return (
    <Sheet open={rec !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent side="right" className="flex flex-col gap-0 sm:max-w-md data-[side=right]:sm:max-w-md">
        <SheetHeader className="pb-0 pr-10">
          <SheetTitle>{rec?.title ?? ''}</SheetTitle>
          <SheetDescription>
            {rec?.detail}
            {total > 0 && (
              <> · <span className="font-medium text-foreground">{total.toLocaleString()} leads</span></>
            )}
          </SheetDescription>
        </SheetHeader>

        {/* Act on the whole cohort — routes to the review surface (nothing is
            sent/moved without the confirmation that lives there). */}
        {rec && (
          <div className="flex flex-wrap gap-2 px-4 pt-4">
            <Button
              size="sm"
              disabled={applying || total === 0}
              onClick={() => onApply(rec)}
            >
              {applying ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <MoveRight className="mr-1 h-3.5 w-3.5" />
              )}
              {actionLabel}
            </Button>
          </div>
        )}

        <div className="mt-3 flex-1 space-y-1.5 overflow-y-auto px-4 pb-4">
          {loading ? (
            <>
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </>
          ) : error ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <AlertTriangle className="h-4 w-4 text-amber-500" /> {error}
            </div>
          ) : leads.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No leads match this recommendation right now
            </p>
          ) : (
            <>
              {leads.map((l) => <CohortLeadRow key={l.id} lead={l} />)}
              {leads.length < total && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="w-full"
                  disabled={loadingMore}
                  onClick={loadMore}
                >
                  {loadingMore ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                  Show more ({(total - leads.length).toLocaleString()} left)
                </Button>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function ago(iso: string | null): string | null {
  if (!iso) return null
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true })
  } catch {
    return null
  }
}

function CohortLeadRow({ lead }: { lead: RecommendationCohortLead }) {
  const contacted = ago(lead.lastContactedAt)
  const subtitle =
    [lead.aiQualification, lead.city].filter(Boolean).join(' · ') ||
    (contacted ? `contacted ${contacted}` : `captured ${ago(lead.createdAt) ?? ''}`)
  return (
    <Link
      href={`/leads/${lead.id}`}
      className="flex items-center justify-between gap-2 rounded-lg border p-2.5 transition-colors hover:bg-accent"
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{lead.name}</p>
        <p className="truncate text-[11px] text-muted-foreground">{subtitle}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {lead.conversationIntent && (
          <Badge variant="outline" className="text-[10px] capitalize">
            {lead.conversationIntent.replace(/_/g, ' ')}
          </Badge>
        )}
        {typeof lead.aiScore === 'number' && (
          <span className="text-[11px] font-semibold text-muted-foreground">{lead.aiScore}</span>
        )}
        <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
    </Link>
  )
}
