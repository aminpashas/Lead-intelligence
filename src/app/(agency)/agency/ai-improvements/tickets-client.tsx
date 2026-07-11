'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatDistanceToNow } from 'date-fns'
import {
  Loader2, ChevronDown, ChevronRight, CheckCircle2, XCircle,
  Play, Eye, RotateCcw, ListChecks,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { AIImprovementTicket } from '@/types/database'

type TicketRow = AIImprovementTicket & { org_name: string | null }

const SEVERITY_STYLES: Record<string, string> = {
  critical: 'bg-aurea-rose/10 text-aurea-rose border border-aurea-rose/20',
  warning: 'bg-aurea-amber/10 text-aurea-amber border border-aurea-amber/20',
  info: 'bg-aurea-surface-2 text-aurea-ink-2 border border-aurea-border',
}

const STATUS_STYLES: Record<string, string> = {
  open: 'bg-aurea-primary/10 text-aurea-primary border border-aurea-primary/20',
  acknowledged: 'bg-aurea-amber/10 text-aurea-amber border border-aurea-amber/20',
  in_progress: 'bg-aurea-amber/10 text-aurea-amber border border-aurea-amber/20',
  resolved: 'bg-aurea-surface-2 text-aurea-ink-2 border border-aurea-border',
  dismissed: 'bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border',
}

const CATEGORY_LABELS: Record<string, string> = {
  agent_logic: 'Agent Logic',
  prompt: 'Prompt',
  telephony: 'Telephony',
  data_gap: 'Data Gap',
  integration: 'Integration',
  other: 'Other',
}

type Filter = 'live' | 'all' | 'resolved'

export function TicketsClient({ tickets }: { tickets: TicketRow[] }) {
  const [filter, setFilter] = useState<Filter>('live')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [actingId, setActingId] = useState<string | null>(null)
  const router = useRouter()

  const visible = useMemo(() => {
    if (filter === 'live') return tickets.filter((t) => !['resolved', 'dismissed'].includes(t.status))
    if (filter === 'resolved') return tickets.filter((t) => ['resolved', 'dismissed'].includes(t.status))
    return tickets
  }, [tickets, filter])

  async function act(id: string, action: 'acknowledge' | 'start' | 'resolve' | 'dismiss' | 'reopen') {
    setActingId(id)
    try {
      const res = await fetch('/api/agency/ai-tickets', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'Request failed')
      const past: Record<typeof action, string> = {
        acknowledge: 'acknowledged', start: 'started', resolve: 'resolved',
        dismiss: 'dismissed', reopen: 'reopened',
      }
      toast.success(`Ticket ${past[action]}`)
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update ticket')
    } finally {
      setActingId(null)
    }
  }

  return (
    <div className="space-y-3">
      {/* Filter pills */}
      <div className="flex items-center gap-2">
        {(['live', 'all', 'resolved'] as Filter[]).map((f) => (
          <Button
            key={f}
            size="sm"
            variant={filter === f ? 'default' : 'outline'}
            className="h-7 px-3 text-xs capitalize"
            onClick={() => setFilter(f)}
          >
            {f === 'live' ? 'Needs action' : f}
          </Button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="aurea-card flex flex-col items-center py-14">
          <ListChecks className="h-8 w-8 text-aurea-ink-3 mb-3" strokeWidth={1.5} />
          <p className="font-medium text-aurea-ink">Nothing here</p>
          <p className="text-sm text-aurea-ink-3 mt-1">
            {filter === 'live'
              ? 'No open AI improvement tickets — the system is running clean.'
              : 'No tickets match this filter yet.'}
          </p>
        </div>
      ) : (
        <div className="aurea-card divide-y divide-aurea-border overflow-hidden">
          {visible.map((ticket) => {
            const expanded = expandedId === ticket.id
            const acting = actingId === ticket.id
            const live = !['resolved', 'dismissed'].includes(ticket.status)
            return (
              <div key={ticket.id}>
                <button
                  type="button"
                  onClick={() => setExpandedId(expanded ? null : ticket.id)}
                  aria-expanded={expanded}
                  className="w-full px-5 py-3.5 flex items-center justify-between gap-3 text-left hover:bg-aurea-surface-2 transition-colors"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge className={(SEVERITY_STYLES[ticket.severity] || SEVERITY_STYLES.info) + ' text-[10px] px-1.5 py-0 uppercase'}>
                        {ticket.severity}
                      </Badge>
                      <Badge className={(STATUS_STYLES[ticket.status] || STATUS_STYLES.open) + ' text-[10px] px-1.5 py-0'}>
                        {ticket.status.replace('_', ' ')}
                      </Badge>
                      <span className="text-[11px] text-aurea-ink-3">
                        {CATEGORY_LABELS[ticket.category] || ticket.category}
                      </span>
                      {ticket.occurrence_count > 1 && (
                        <span className="text-[11px] font-mono tabular-nums text-aurea-ink-3">
                          ×{ticket.occurrence_count}
                        </span>
                      )}
                    </div>
                    <p className="font-medium text-sm text-aurea-ink mt-1 truncate">{ticket.title}</p>
                    <p className="text-xs text-aurea-ink-3 mt-0.5">
                      {ticket.org_name || 'Unattributed'} · {ticket.source === 'system_check' ? 'System check' : 'Post-call review'} ·
                      {' '}last seen {formatDistanceToNow(new Date(ticket.last_seen_at), { addSuffix: true })}
                    </p>
                  </div>
                  {expanded
                    ? <ChevronDown className="h-4 w-4 shrink-0 text-aurea-ink-3" strokeWidth={1.75} />
                    : <ChevronRight className="h-4 w-4 shrink-0 text-aurea-ink-3" strokeWidth={1.75} />}
                </button>

                {expanded && (
                  <div className="px-5 pb-5 pt-1 space-y-3 bg-aurea-surface-2/40">
                    {ticket.summary && (
                      <p className="text-[13px] leading-relaxed text-aurea-ink-2">{ticket.summary}</p>
                    )}
                    {ticket.recommendation && (
                      <div>
                        <p className="aurea-eyebrow mb-1">Recommendation</p>
                        <p className="text-[13px] leading-relaxed text-aurea-ink">{ticket.recommendation}</p>
                      </div>
                    )}
                    {Array.isArray(ticket.action_plan) && ticket.action_plan.length > 0 && (
                      <div>
                        <p className="aurea-eyebrow mb-1">Action plan</p>
                        <ol className="list-decimal pl-5 space-y-1 text-[13px] text-aurea-ink-2">
                          {ticket.action_plan.map((step, i) => (
                            <li key={i}>{String(step)}</li>
                          ))}
                        </ol>
                      </div>
                    )}
                    {ticket.resolution_note && (
                      <p className="text-[12px] text-aurea-ink-3">
                        <span className="font-medium">Resolution:</span> {ticket.resolution_note}
                      </p>
                    )}

                    <div className="flex items-center gap-2 pt-1">
                      {live && ticket.status === 'open' && (
                        <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" disabled={acting} onClick={() => act(ticket.id, 'acknowledge')}>
                          {acting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />}
                          Acknowledge
                        </Button>
                      )}
                      {live && ticket.status !== 'in_progress' && (
                        <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" disabled={acting} onClick={() => act(ticket.id, 'start')}>
                          {acting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" strokeWidth={1.75} />}
                          Start
                        </Button>
                      )}
                      {live && (
                        <>
                          <Button size="sm" className="h-7 gap-1.5 text-xs bg-aurea-primary text-white hover:bg-aurea-primary/90" disabled={acting} onClick={() => act(ticket.id, 'resolve')}>
                            {acting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.75} />}
                            Resolve
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs text-aurea-ink-3" disabled={acting} onClick={() => act(ticket.id, 'dismiss')}>
                            {acting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" strokeWidth={1.75} />}
                            Dismiss
                          </Button>
                        </>
                      )}
                      {!live && (
                        <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" disabled={acting} onClick={() => act(ticket.id, 'reopen')}>
                          {acting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} />}
                          Reopen
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
