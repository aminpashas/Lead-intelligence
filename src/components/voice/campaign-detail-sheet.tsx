'use client'

/**
 * Campaign detail drill-down.
 *
 * Opens from a campaign card. Shows KPIs computed from voice_calls (the source of
 * truth — including "Responded") and a lead list where each row expands to that
 * lead's communication history for this campaign.
 */

import { useEffect, useState } from 'react'
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet'
import { Badge } from '@/components/ui/badge'
import {
  Loader2, ChevronDown, ChevronRight, PhoneCall, PhoneOff, PhoneForwarded, MessageSquare,
} from 'lucide-react'

type CampaignKpis = {
  total_leads: number
  called: number
  called_pct: number
  dials: number
  answered: number
  responded: number
  sent_to_heather: number
  booked: number
  no_answer_vm: number
}
type LeadCall = {
  status: string
  outcome: string | null
  duration_seconds: number | null
  started_at: string | null
  transfer_status: string | null
  bridged: boolean
  summary: string | null
}
type LeadRow = {
  lead_id: string
  name: string
  phone: string
  status: string
  attempts: number
  last_attempt_at: string | null
  outcome: string | null
  calls: LeadCall[]
}
type DetailData = {
  campaign: { id: string; name: string; status: string; auto_enroll: boolean }
  kpis: CampaignKpis
  leads: LeadRow[]
}

function pct(n: number, d: number): string {
  return d > 0 ? `${Math.round((n / d) * 100)}%` : '0%'
}

function Kpi({ label, value, sub, accent }: { label: string; value: number; sub?: string; accent?: boolean }) {
  return (
    <div className={`rounded-lg p-3 ${accent ? 'bg-emerald-50' : 'bg-aurea-surface-2'}`}>
      <p className={`text-xs ${accent ? 'text-emerald-700' : 'text-aurea-ink-3'}`}>{label}</p>
      <p className={`text-2xl font-medium tabular-nums ${accent ? 'text-emerald-700' : 'text-aurea-ink'}`}>
        {value.toLocaleString()}
      </p>
      {sub && <p className={`text-xs ${accent ? 'text-emerald-700' : 'text-aurea-ink-3'}`}>{sub}</p>}
    </div>
  )
}

function LeadItem({ lead }: { lead: LeadRow }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-b border-aurea-line py-2.5">
      <button className="flex w-full items-center gap-3 text-left" onClick={() => setOpen(o => !o)}>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-aurea-ink">{lead.name}</p>
          <p className="text-xs text-aurea-ink-3">{lead.phone} · {lead.attempts} attempt{lead.attempts === 1 ? '' : 's'}</p>
        </div>
        <Badge variant="outline" className="shrink-0 text-xs capitalize">{(lead.outcome || lead.status).replace(/_/g, ' ')}</Badge>
        {open ? <ChevronDown className="h-4 w-4 text-aurea-ink-3" /> : <ChevronRight className="h-4 w-4 text-aurea-ink-3" />}
      </button>
      {open && (
        <div className="ml-1 mt-2 border-l-2 border-aurea-line pl-3">
          {lead.calls.length === 0 ? (
            <p className="py-1 text-xs text-aurea-ink-3">No calls placed yet.</p>
          ) : (
            lead.calls.map((c, i) => {
              const talked = c.bridged || (c.duration_seconds ?? 0) > 0
              return (
              <div key={i} className="mb-2.5">
                <p className="text-xs text-aurea-ink-3">
                  {c.started_at ? new Date(c.started_at).toLocaleString() : '—'}
                </p>
                <p className="flex items-center gap-1.5 text-sm text-aurea-ink">
                  {c.bridged
                    ? <PhoneForwarded className="h-3.5 w-3.5 text-emerald-600" strokeWidth={1.75} />
                    : talked ? <PhoneCall className="h-3.5 w-3.5 text-emerald-600" strokeWidth={1.75} />
                    : <PhoneOff className="h-3.5 w-3.5 text-aurea-ink-3" strokeWidth={1.75} />}
                  <span className="capitalize">{(c.outcome || c.status || 'call').replace(/_/g, ' ')}</span>
                  {typeof c.duration_seconds === 'number' && c.duration_seconds > 0 && (
                    <span className="text-aurea-ink-3">· {c.duration_seconds}s</span>
                  )}
                  {c.bridged && <span className="text-emerald-700">· bridged to rep</span>}
                </p>
                {c.summary && (
                  <p className="mt-1 flex items-start gap-1.5 rounded-md bg-aurea-surface-2 px-2 py-1.5 text-xs text-aurea-ink-3">
                    <MessageSquare className="mt-0.5 h-3 w-3 shrink-0" strokeWidth={1.75} />
                    {c.summary}
                  </p>
                )}
              </div>
            )})
          )}
        </div>
      )}
    </div>
  )
}

export function CampaignDetailSheet({
  campaignId, name, open, onOpenChange,
}: { campaignId: string | null; name: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [data, setData] = useState<DetailData | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || !campaignId) return
    setLoading(true)
    setData(null)
    fetch(`/api/voice/campaign/${campaignId}`)
      .then(r => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [open, campaignId])

  const k = data?.kpis
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="text-aurea-ink">{name}</SheetTitle>
          <SheetDescription className="text-aurea-ink-3">
            Live progress and every call placed, straight from the call log.
          </SheetDescription>
        </SheetHeader>

        {loading && (
          <div className="flex items-center justify-center py-16 text-aurea-ink-3">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        )}

        {k && (
          <div className="mt-4 space-y-5">
            <div>
              <div className="mb-1.5 flex items-center justify-between text-xs text-aurea-ink-3">
                <span>Leads called</span>
                <span className="tabular-nums">{k.called.toLocaleString()} of {k.total_leads.toLocaleString()} · {k.called_pct}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-aurea-surface-2">
                <div className="h-full rounded-full bg-aurea-primary" style={{ width: `${Math.min(100, k.called_pct)}%` }} />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <Kpi label="Answered" value={k.answered} sub={`${pct(k.answered, k.dials)} of dials`} />
              <Kpi label="Responded" value={k.responded} sub={`${pct(k.responded, k.dials)} of dials`} accent />
              <Kpi label="Sent to rep" value={k.sent_to_heather} sub={`${pct(k.sent_to_heather, k.responded)} of resp.`} />
              <Kpi label="Booked" value={k.booked} sub={`${pct(k.booked, k.responded)} of resp.`} />
              <Kpi label="No answer / VM" value={k.no_answer_vm} sub="will retry" />
              <Kpi label="Total dials" value={k.dials} />
            </div>

            <div>
              <p className="aurea-eyebrow mb-1">Communication</p>
              {data.leads.length === 0 ? (
                <p className="py-3 text-sm text-aurea-ink-3">No leads dialed yet.</p>
              ) : (
                <div>{data.leads.map(l => <LeadItem key={l.lead_id} lead={l} />)}</div>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
