'use client'

/**
 * Needs you — the decision queue at the heart of the dashboard.
 *
 * Every card is a decision the AI has already prepared: an escalated draft reply,
 * an appointment at risk of no-show, a hot lead going cold. Buttons act through the
 * existing hardened endpoints (consent, quiet hours, and the kill switch all still
 * apply server-side); nothing here invents a new send path.
 */

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { formatDistanceToNow, format } from 'date-fns'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  MessageSquare, CalendarX, Snowflake, Phone, Loader2, ShieldCheck, ArrowRight,
} from 'lucide-react'

type QueueLead = {
  id: string
  first_name: string | null
  last_name: string | null
  phone: string | null
} | null

export type EscalationItem = {
  id: string
  reason: string | null
  ai_notes: string | null
  ai_draft_response: string | null
  ai_confidence: number | null
  agent_type: string | null
  created_at: string
  lead_id: string
  lead: QueueLead
}

export type RiskyAppointmentItem = {
  id: string
  scheduled_at: string
  no_show_risk_score: number
  lead: QueueLead
}

export type StaleHotLeadItem = {
  id: string
  first_name: string | null
  last_name: string | null
  phone: string | null
  ai_score: number | null
  last_contacted_at: string | null
}

function leadName(lead: QueueLead | StaleHotLeadItem | null) {
  if (!lead) return 'Unknown lead'
  return [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Unknown lead'
}

export function DecisionQueue({
  escalations,
  riskyAppointments,
  staleHotLeads,
  watchingCount,
}: {
  escalations: EscalationItem[]
  riskyAppointments: RiskyAppointmentItem[]
  staleHotLeads: StaleHotLeadItem[]
  watchingCount: number
}) {
  const router = useRouter()
  const [resolved, setResolved] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)

  const visibleEscalations = escalations.filter((e) => !resolved.has(e.id))
  const total = visibleEscalations.length + riskyAppointments.length + staleHotLeads.length

  async function patchEscalation(id: string, action: 'resolve' | 'dismiss', notes?: string) {
    const res = await fetch('/api/autopilot/escalations', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ escalation_id: id, action, resolution_notes: notes }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || `Failed (${res.status})`)
    }
  }

  async function approveAndSend(item: EscalationItem) {
    if (!item.ai_draft_response || busy) return
    setBusy(item.id)
    try {
      const sendRes = await fetch('/api/sms/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: item.lead_id, message: item.ai_draft_response }),
      })
      if (!sendRes.ok) {
        const err = await sendRes.json().catch(() => ({}))
        throw new Error(err.error || `Send failed (${sendRes.status})`)
      }
      await patchEscalation(item.id, 'resolve', 'Draft approved and sent from dashboard')
      setResolved((cur) => new Set(cur).add(item.id))
      toast.success(`Sent to ${leadName(item.lead)}`)
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setBusy(null)
    }
  }

  async function dismiss(item: EscalationItem) {
    if (busy) return
    setBusy(item.id)
    try {
      await patchEscalation(item.id, 'dismiss', 'Dismissed from dashboard')
      setResolved((cur) => new Set(cur).add(item.id))
      toast.success('Dismissed')
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="aurea-display text-[18px] leading-tight text-aurea-ink">Needs you</h2>
        {total > 0 && (
          <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-aurea-rose/10 px-1.5 text-[11px] font-semibold tabular-nums text-aurea-rose ring-1 ring-aurea-rose/20">
            {total}
          </span>
        )}
      </div>

      {total === 0 ? (
        <div className="aurea-card flex flex-col items-center gap-2 px-6 py-10 text-center">
          <ShieldCheck className="h-6 w-6 text-aurea-primary" strokeWidth={1.5} />
          <p className="text-[14px] font-medium text-aurea-ink">All clear</p>
          <p className="max-w-sm text-[13px] leading-relaxed text-aurea-ink-3">
            Nothing needs your decision right now.
            {watchingCount > 0 && ` I'm watching ${watchingCount} active conversation${watchingCount === 1 ? '' : 's'} and will flag anything that needs you.`}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {visibleEscalations.map((item) => (
            <article key={item.id} className="aurea-card px-5 py-4">
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <MessageSquare className="h-4 w-4 shrink-0 text-aurea-ink-3" strokeWidth={1.75} />
                  <p className="truncate text-[14px] font-medium text-aurea-ink">
                    {item.ai_draft_response ? 'Reply drafted' : 'Needs review'} — {leadName(item.lead)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2 font-mono text-[11px] text-aurea-ink-3">
                  {item.ai_confidence != null && <span>{Math.round(item.ai_confidence * 100)}% confident</span>}
                  <span>{formatDistanceToNow(new Date(item.created_at), { addSuffix: true })}</span>
                </div>
              </div>
              {item.reason && (
                <p className="mb-1 text-[12px] text-aurea-ink-3">Escalated: {item.reason.replace(/_/g, ' ')}</p>
              )}
              {item.ai_draft_response && (
                <blockquote className="mb-3 border-l-2 border-aurea-border pl-3 text-[13px] leading-relaxed text-aurea-ink-2">
                  {item.ai_draft_response}
                </blockquote>
              )}
              {!item.ai_draft_response && item.ai_notes && (
                <p className="mb-3 text-[13px] leading-relaxed text-aurea-ink-2">{item.ai_notes}</p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {item.ai_draft_response && (
                  <Button size="sm" className="h-8 gap-1.5" disabled={busy === item.id} onClick={() => approveAndSend(item)}>
                    {busy === item.id && <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />}
                    Approve and send
                  </Button>
                )}
                <Link href={`/leads/${item.lead_id}`}>
                  <Button variant="outline" size="sm" className="h-8">Open lead</Button>
                </Link>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-aurea-ink-3"
                  disabled={busy === item.id}
                  onClick={() => dismiss(item)}
                >
                  Dismiss
                </Button>
              </div>
            </article>
          ))}

          {riskyAppointments.map((appt) => (
            <article key={appt.id} className="aurea-card px-5 py-4">
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <CalendarX className="h-4 w-4 shrink-0 text-aurea-amber" strokeWidth={1.75} />
                  <p className="truncate text-[14px] font-medium text-aurea-ink">
                    No-show risk — {leadName(appt.lead)}, {format(new Date(appt.scheduled_at), 'EEE h:mma')}
                  </p>
                </div>
                <span className="shrink-0 rounded-md bg-aurea-amber/10 px-2 py-0.5 text-[11px] font-medium text-aurea-amber ring-1 ring-aurea-amber/20">
                  risk {appt.no_show_risk_score}
                </span>
              </div>
              <p className="mb-3 text-[13px] leading-relaxed text-aurea-ink-2">
                Hasn&apos;t confirmed despite reminders. A personal call beats another text.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {appt.lead?.phone && (
                  <a href={`tel:${appt.lead.phone}`}>
                    <Button size="sm" className="h-8 gap-1.5">
                      <Phone className="h-3.5 w-3.5" strokeWidth={1.75} /> Call now
                    </Button>
                  </a>
                )}
                <Link href="/appointments">
                  <Button variant="outline" size="sm" className="h-8">View appointment</Button>
                </Link>
              </div>
            </article>
          ))}

          {staleHotLeads.map((lead) => (
            <article key={lead.id} className="aurea-card px-5 py-4">
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Snowflake className="h-4 w-4 shrink-0 text-aurea-rose" strokeWidth={1.75} />
                  <p className="truncate text-[14px] font-medium text-aurea-ink">
                    Going cold — {leadName(lead)}
                  </p>
                </div>
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-aurea-ink-3">score {lead.ai_score ?? '—'}</span>
              </div>
              <p className="mb-3 text-[13px] leading-relaxed text-aurea-ink-2">
                Hot lead with no touch
                {lead.last_contacted_at
                  ? ` since ${formatDistanceToNow(new Date(lead.last_contacted_at), { addSuffix: true })}`
                  : ' on record'}
                . Worth a direct call before they book elsewhere.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {lead.phone && (
                  <a href={`tel:${lead.phone}`}>
                    <Button size="sm" className="h-8 gap-1.5">
                      <Phone className="h-3.5 w-3.5" strokeWidth={1.75} /> Call
                    </Button>
                  </a>
                )}
                <Link href={`/leads/${lead.id}`}>
                  <Button variant="outline" size="sm" className="h-8 gap-1.5">
                    Open lead <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </Button>
                </Link>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
