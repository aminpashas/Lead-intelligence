'use client'

/**
 * Action Center cohort drill-down: the lead list behind a queue tile or
 * recommendation, with smart-list-style batch actions.
 *
 * Read path:  GET /api/analytics/action-queue/:cohort (paginated, count-exact
 * with the tile because both sides share analytics_in_action_cohort()).
 *
 * Act path:   POST /api/analytics/action-queue/:cohort/materialize — pins the
 * cohort into a Smart List snapshot and deep-links to the existing review
 * surfaces (Mass SMS / Mass Email composer, Audiences bulk actions). Nothing
 * is sent from here; the composers own the consent/A2P/cap gates.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { formatDistanceToNow } from 'date-fns'
import { toast } from 'sonner'
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@/components/ui/sheet'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  AlertTriangle, ArrowRight, ListChecks, Loader2, Mail, MessageSquare,
} from 'lucide-react'
import {
  ACTION_QUEUE_COHORTS,
  type ActionQueueCohortKey,
  type ActionQueueCohortLead,
  type ActionQueueCohortPage,
} from '@/lib/analytics/deep-types'

const PAGE_SIZE = 50

type MaterializeTarget = 'sms' | 'email' | 'audience'

export function ActionQueueCohortSheet({
  cohort,
  onClose,
}: {
  /** Which cohort to show — null keeps the sheet closed. */
  cohort: ActionQueueCohortKey | null
  onClose: () => void
}) {
  const router = useRouter()
  const [leads, setLeads] = useState<ActionQueueCohortLead[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [materializing, setMaterializing] = useState<MaterializeTarget | null>(null)

  const fetchPage = useCallback(async (key: ActionQueueCohortKey, offset: number) => {
    const res = await fetch(`/api/analytics/action-queue/${key}?limit=${PAGE_SIZE}&offset=${offset}`)
    const body = await res.json().catch(() => null)
    if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`)
    return body as ActionQueueCohortPage
  }, [])

  useEffect(() => {
    if (!cohort) return
    let cancelled = false
    setLeads([])
    setTotal(0)
    setError(null)
    setLoading(true)
    fetchPage(cohort, 0)
      .then((page) => {
        if (cancelled) return
        setLeads(page.leads)
        setTotal(page.total)
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load cohort') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [cohort, fetchPage])

  const loadMore = async () => {
    if (!cohort) return
    setLoadingMore(true)
    try {
      const page = await fetchPage(cohort, leads.length)
      setLeads((prev) => [...prev, ...page.leads])
      setTotal(page.total)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load more')
    } finally {
      setLoadingMore(false)
    }
  }

  const materialize = async (target: MaterializeTarget) => {
    if (!cohort) return
    setMaterializing(target)
    try {
      const res = await fetch(`/api/analytics/action-queue/${cohort}/materialize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`)
      if (body.capped) {
        toast.warning(
          `Cohort has ${body.total.toLocaleString()} leads — snapshot pinned the freshest ${body.leadCount.toLocaleString()}.`
        )
      }
      router.push(body.redirect)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to build the segment')
      setMaterializing(null)
    }
  }

  const meta = cohort ? ACTION_QUEUE_COHORTS[cohort] : null

  return (
    <Sheet open={cohort !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent side="right" className="sm:max-w-md data-[side=right]:sm:max-w-md">
        <SheetHeader className="pb-0 pr-10">
          <SheetTitle>{meta?.label ?? ''}</SheetTitle>
          <SheetDescription>
            {meta?.description}
            {total > 0 && <> · <span className="font-medium text-foreground">{total.toLocaleString()} leads</span></>}
          </SheetDescription>
        </SheetHeader>

        {/* Batch actions — review-first: each lands on the composer/audience
            surface where the actual send is confirmed behind consent gates. */}
        <div className="flex flex-wrap gap-2 px-4">
          <Button
            size="sm"
            disabled={loading || total === 0 || materializing !== null}
            onClick={() => materialize('sms')}
          >
            {materializing === 'sms'
              ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              : <MessageSquare className="mr-1 h-3.5 w-3.5" />}
            Text all
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={loading || total === 0 || materializing !== null}
            onClick={() => materialize('email')}
          >
            {materializing === 'email'
              ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              : <Mail className="mr-1 h-3.5 w-3.5" />}
            Email all
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={loading || total === 0 || materializing !== null}
            onClick={() => materialize('audience')}
          >
            {materializing === 'audience'
              ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              : <ListChecks className="mr-1 h-3.5 w-3.5" />}
            Save as Smart List
          </Button>
        </div>

        <div className="flex-1 space-y-1.5 overflow-y-auto px-4 pb-4">
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
              Nothing in this queue right now
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
                  {loadingMore
                    ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    : null}
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

function CohortLeadRow({ lead }: { lead: ActionQueueCohortLead }) {
  const lastIn = ago(lead.last_responded_at)
  const lastOut = ago(lead.last_contacted_at)
  return (
    <Link
      href={`/leads/${lead.id}`}
      className="flex items-center justify-between gap-2 rounded-lg border p-2.5 transition-colors hover:bg-accent"
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{lead.name}</p>
        <p className="truncate text-[11px] text-muted-foreground">
          {lastIn ? `replied ${lastIn}` : lastOut ? `contacted ${lastOut}` : `captured ${ago(lead.created_at) ?? ''}`}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {lead.conversation_intent && (
          <Badge variant="outline" className="text-[10px] capitalize">
            {lead.conversation_intent.replace(/_/g, ' ')}
          </Badge>
        )}
        <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
    </Link>
  )
}
