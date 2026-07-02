'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Check, X, Archive } from 'lucide-react'
import type { AgencyAiRule } from '@/types/database'

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  pending: { label: 'Pending review', className: 'bg-aurea-amber/10 text-aurea-amber border-aurea-amber/30' },
  approved: { label: 'Live', className: 'bg-aurea-primary/10 text-aurea-primary border-aurea-primary/30' },
  retire_flagged: { label: 'Flagged — underperforming', className: 'bg-aurea-rose/10 text-aurea-rose border-aurea-rose/30' },
  rejected: { label: 'Rejected', className: 'bg-aurea-surface-2 text-aurea-ink-3 border-aurea-border' },
  retired: { label: 'Retired', className: 'bg-aurea-surface-2 text-aurea-ink-3 border-aurea-border' },
}

export function LearnedRulesList({ rules }: { rules: AgencyAiRule[] }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function act(id: string, action: 'approve' | 'reject' | 'retire') {
    setBusyId(id)
    setError(null)
    try {
      const res = await fetch('/api/agency/learning/rules', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `Request failed (${res.status})`)
      }
      startTransition(() => router.refresh())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setBusyId(null)
    }
  }

  if (rules.length === 0) {
    return (
      <Card className="bg-aurea-surface border-aurea-border">
        <CardContent className="py-10 text-center">
          <p className="text-sm text-aurea-ink-2">No learned rules yet.</p>
          <p className="text-xs text-aurea-ink-3 mt-1">
            The weekly distillation run proposes rules once enough outcome-labeled journeys have
            accumulated (it requires statistically significant won-vs-lost contrasts, so this is
            expected to stay empty during ramp-up).
          </p>
        </CardContent>
      </Card>
    )
  }

  // Pending first, then flagged, then the rest
  const order = (r: AgencyAiRule) =>
    r.review_status === 'pending' ? 0 : r.review_status === 'retire_flagged' ? 1 : 2
  const sorted = [...rules].sort((a, b) => order(a) - order(b))

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-aurea-rose">{error}</p>}
      {sorted.map((rule) => {
        const badge = STATUS_BADGE[rule.review_status || 'pending'] || STATUS_BADGE.pending
        const busy = busyId === rule.id || isPending
        return (
          <Card key={rule.id} className="bg-aurea-surface border-aurea-border">
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-base text-aurea-ink">{rule.title}</CardTitle>
                  <CardDescription className="text-xs text-aurea-ink-3 mt-0.5">
                    Proposed {new Date(rule.created_at).toLocaleDateString()}
                    {rule.approved_at && ` · approved ${new Date(rule.approved_at).toLocaleDateString()} by ${rule.approved_by}`}
                  </CardDescription>
                </div>
                <Badge variant="outline" className={badge.className}>{badge.label}</Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-aurea-ink whitespace-pre-wrap">{rule.content}</p>

              {rule.evidence && (
                <div className="rounded-lg bg-aurea-surface-2/60 border border-aurea-border p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-aurea-ink-3 mb-1">
                    Why the engine proposes this
                  </p>
                  <p className="text-xs text-aurea-ink-2">{rule.evidence.detail}</p>
                </div>
              )}

              {rule.performance && (
                <p className="text-xs text-aurea-ink-3">
                  Cohort check: booked-rate {Math.round(rule.performance.before.rate * 100)}% before
                  ({rule.performance.before.n} leads) → {Math.round(rule.performance.after.rate * 100)}%
                  after ({rule.performance.after.n} leads), z={rule.performance.z}
                </p>
              )}

              {(rule.review_status === 'pending' || rule.review_status === 'retire_flagged') && (
                <div className="flex gap-2 pt-1">
                  {rule.review_status === 'pending' && (
                    <>
                      <Button size="sm" disabled={busy} onClick={() => act(rule.id, 'approve')}>
                        <Check className="h-3.5 w-3.5 mr-1" /> Approve &amp; go live
                      </Button>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => act(rule.id, 'reject')}>
                        <X className="h-3.5 w-3.5 mr-1" /> Reject
                      </Button>
                    </>
                  )}
                  {rule.review_status === 'retire_flagged' && (
                    <>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => act(rule.id, 'retire')}>
                        <Archive className="h-3.5 w-3.5 mr-1" /> Retire rule
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(rule.id, 'approve')}>
                        Keep live
                      </Button>
                    </>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
