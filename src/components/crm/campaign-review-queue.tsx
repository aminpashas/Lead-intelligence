'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { formatDistanceToNow } from 'date-fns'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

export type ReviewDraft = {
  id: string
  lead_id: string
  lead_name: string
  campaign_name: string
  channel: 'sms' | 'email'
  subject: string | null
  body: string
  created_at: string
}

/**
 * The review_first draft-approval queue. Optimistic: on approve/reject the card
 * is removed immediately; on API failure it's restored and a toast explains.
 * Approving sends the stored body through the consent-gated messaging layer
 * (server-side); rejecting sends nothing.
 */
export function ReviewQueue({ initialDrafts }: { initialDrafts: ReviewDraft[] }) {
  const [drafts, setDrafts] = useState<ReviewDraft[]>(initialDrafts)
  const [busy, setBusy] = useState<Record<string, boolean>>({})

  async function decide(draft: ReviewDraft, action: 'approve' | 'reject') {
    setBusy((b) => ({ ...b, [draft.id]: true }))
    // Optimistically drop the card.
    setDrafts((ds) => ds.filter((d) => d.id !== draft.id))

    try {
      const res = await fetch(`/api/campaigns/review-drafts/${draft.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.error || 'Request failed')

      if (action === 'approve') {
        toast.success(
          json.sent_via
            ? `Approved — sent to ${draft.lead_name} via ${json.sent_via}.`
            : `Approved, but nothing sent (no consented channel for ${draft.lead_name}).`
        )
      } else {
        toast.success(`Rejected — nothing was sent to ${draft.lead_name}.`)
      }
    } catch (err) {
      // Restore the card so the staffer can retry.
      setDrafts((ds) => [draft, ...ds])
      toast.error(err instanceof Error ? err.message : 'Could not process this draft.')
    } finally {
      setBusy((b) => {
        const next = { ...b }
        delete next[draft.id]
        return next
      })
    }
  }

  if (drafts.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border/70 p-12 text-center">
        <p className="text-sm font-medium">Nothing to review</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Campaigns running in <span className="font-medium">review-first</span> mode queue their
          messages here for approval before sending. You&apos;re all caught up.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Review Queue</h1>
          <p className="text-sm text-muted-foreground">
            {drafts.length} message{drafts.length === 1 ? '' : 's'} awaiting your approval before
            they send.
          </p>
        </div>
      </div>

      <div className="space-y-3">
        {drafts.map((draft) => (
          <Card key={draft.id}>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-sm">{draft.lead_name}</CardTitle>
                <Badge variant="secondary">{draft.channel.toUpperCase()}</Badge>
                <span className="text-xs text-muted-foreground">· {draft.campaign_name}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {formatDistanceToNow(new Date(draft.created_at), { addSuffix: true })}
                </span>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {draft.channel === 'email' && draft.subject && (
                <p className="text-sm">
                  <span className="text-muted-foreground">Subject:</span> {draft.subject}
                </p>
              )}
              <p className="whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-sm">{draft.body}</p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={busy[draft.id]}
                  onClick={() => decide(draft, 'approve')}
                >
                  Approve &amp; send
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy[draft.id]}
                  onClick={() => decide(draft, 'reject')}
                >
                  Reject
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
