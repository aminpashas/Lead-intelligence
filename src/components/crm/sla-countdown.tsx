'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Bot, Clock, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatCountdown } from '@/lib/automation/matrix'

/**
 * SLA countdown banner (conversation thread stitch).
 *
 * When this conversation has a PENDING message_response_slas timer — the lead
 * replied and the org's human-first window is running — show "AI takes over
 * in m:ss" with two escape hatches:
 *   * Take over now → close the timer as human_responded + complete the task
 *   * Let AI answer → run the takeover immediately (all safety gates apply)
 *
 * Self-contained: fetches its own state so the (large, frequently edited)
 * thread component only mounts it.
 */

type PendingSla = {
  id: string
  deadline_at: string
  inbound_at: string
  sla_seconds: number
  status: string
}

export function SlaCountdown({ conversationId }: { conversationId: string }) {
  const [sla, setSla] = useState<PendingSla | null>(null)
  const [remainingMs, setRemainingMs] = useState(0)
  const [acting, setActing] = useState<'claim' | 'ai_now' | null>(null)
  const expiredRefetches = useRef(0)

  const refetch = useCallback(async () => {
    try {
      const res = await fetch(`/api/conversations/${conversationId}/sla`)
      if (!res.ok) return
      const json = await res.json()
      setSla(json.sla ?? null)
    } catch {
      /* banner is a courtesy — never surface the failure */
    }
  }, [conversationId])

  useEffect(() => {
    expiredRefetches.current = 0
    refetch()
  }, [refetch])

  // Tick the countdown; after the deadline, poll a few times so the banner
  // clears itself once the takeover cron resolves the row.
  useEffect(() => {
    if (!sla) return
    const deadline = new Date(sla.deadline_at).getTime()
    setRemainingMs(deadline - Date.now())
    const t = setInterval(() => {
      const left = deadline - Date.now()
      setRemainingMs(left)
      if (left <= 0 && expiredRefetches.current < 8) {
        expiredRefetches.current += 1
        refetch()
      }
    }, 1000)
    return () => clearInterval(t)
  }, [sla, refetch])

  if (!sla) return null

  async function act(action: 'claim' | 'ai_now') {
    setActing(action)
    try {
      const res = await fetch(`/api/conversations/${conversationId}/sla`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new Error(json?.error || 'Action failed')
      if (action === 'claim') {
        toast.success('Conversation is yours — the AI is standing down')
      } else if (json?.outcome === 'taken_over') {
        toast.success('AI answered the lead')
      } else if (json?.outcome === 'human_responded') {
        toast.success('A human reply already landed — timer closed')
      } else {
        toast.info('AI could not send (a safety gate blocked it) — the lead still needs a reply')
      }
      await refetch()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setActing(null)
    }
  }

  const expired = remainingMs <= 0

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2 lg:px-5 ${
        expired
          ? 'border-aurea-rose/30 bg-aurea-rose/10'
          : 'border-aurea-amber/30 bg-aurea-amber/10'
      }`}
    >
      <div className="flex items-center gap-2 text-[12.5px] font-medium text-aurea-ink">
        <Clock
          className={`h-3.5 w-3.5 ${expired ? 'text-aurea-rose' : 'text-aurea-amber'}`}
          strokeWidth={1.75}
        />
        {expired ? (
          <span>Response window expired — AI takeover in progress…</span>
        ) : (
          <span>
            AI takes over in{' '}
            <span className="font-mono tabular-nums">{formatCountdown(remainingMs)}</span>
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 text-[12px]"
          disabled={acting != null}
          onClick={() => act('claim')}
        >
          {acting === 'claim' && <Loader2 className="h-3 w-3 animate-spin" />}
          Take over now
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 text-[12px]"
          disabled={acting != null}
          onClick={() => act('ai_now')}
        >
          {acting === 'ai_now' ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Bot className="h-3 w-3 text-aurea-primary" strokeWidth={1.75} />
          )}
          Let AI answer
        </Button>
      </div>
    </div>
  )
}
