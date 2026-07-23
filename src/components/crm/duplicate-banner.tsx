'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Copy, ExternalLink, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export type DuplicateCandidateView = {
  id: string
  name: string
  status: string | null
  created_at: string
  signals: Array<'phone' | 'email' | 'identity' | 'name'>
  confidence: 'high' | 'medium' | 'low'
  score: number
}

const SIGNAL_LABEL: Record<DuplicateCandidateView['signals'][number], string> = {
  phone: 'same phone',
  email: 'same email',
  identity: 'linked account',
  name: 'same name',
}

/**
 * "Possible duplicate of X" banner on the lead detail page.
 *
 * Detection is server-fetched (medium+ confidence only). Admins get a Merge
 * control that consolidates the candidate INTO the lead being viewed — the one
 * on screen is treated as the survivor. Non-admins see the heads-up and a link,
 * but no merge button (the API enforces the same gate regardless).
 *
 * "Not a duplicate" only dismisses the row for this view; it is intentionally
 * cheap — re-detection is idempotent and the review task is the durable record.
 */
export function DuplicateBanner({
  leadId,
  initialCandidates,
  canMerge,
}: {
  leadId: string
  initialCandidates: DuplicateCandidateView[]
  canMerge: boolean
}) {
  const router = useRouter()
  const [candidates, setCandidates] = useState(initialCandidates)
  const [busyId, setBusyId] = useState<string | null>(null)

  if (candidates.length === 0) return null

  async function merge(loserId: string) {
    if (!confirm('Merge this duplicate into the lead you are viewing? The duplicate is hidden and can be restored later.')) {
      return
    }
    setBusyId(loserId)
    try {
      const res = await fetch('/api/leads/duplicates/merge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ winnerId: leadId, loserId }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || 'Merge failed')
      toast.success('Duplicate merged in')
      setCandidates((cs) => cs.filter((c) => c.id !== loserId))
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Merge failed')
    } finally {
      setBusyId(null)
    }
  }

  function dismiss(id: string) {
    setCandidates((cs) => cs.filter((c) => c.id !== id))
  }

  return (
    <div className="border-b border-amber-500/30 bg-amber-500/5 px-4 py-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
        <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />
        {candidates.length === 1 ? 'Possible duplicate' : `${candidates.length} possible duplicates`}
      </div>
      <ul className="space-y-2">
        {candidates.map((c) => {
          const isBusy = busyId === c.id
          return (
            <li
              key={c.id}
              className="flex items-start justify-between gap-3 rounded-md border border-amber-500/20 bg-aurea-surface px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <a
                    href={`/leads/${c.id}`}
                    className="truncate text-[13px] font-medium text-aurea-ink hover:underline"
                  >
                    {c.name}
                  </a>
                  <ExternalLink className="h-3 w-3 shrink-0 text-aurea-ink-3" strokeWidth={1.75} />
                  <Badge
                    variant="outline"
                    className={cn(
                      'h-4 px-1.5 text-[10px] capitalize',
                      c.confidence === 'high'
                        ? 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
                        : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
                    )}
                  >
                    {c.confidence} match
                  </Badge>
                </div>
                <div className="mt-0.5 text-[11px] text-aurea-ink-3">
                  {c.signals.map((s) => SIGNAL_LABEL[s]).join(' · ')}
                  {c.status ? ` · ${c.status}` : ''}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {canMerge && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={isBusy}
                    className="h-7 px-2 text-[11px]"
                    onClick={() => merge(c.id)}
                  >
                    Merge into this lead
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={isBusy}
                  aria-label="Not a duplicate"
                  className="h-7 w-7 p-0 text-aurea-ink-3"
                  onClick={() => dismiss(c.id)}
                >
                  <X className="h-3.5 w-3.5" strokeWidth={1.75} />
                </Button>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
