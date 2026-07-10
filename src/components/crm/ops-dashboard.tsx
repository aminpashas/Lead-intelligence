'use client'

import Link from 'next/link'
import { format, isTomorrow } from 'date-fns'
import { cn } from '@/lib/utils'
import {
  Users, TrendingUp, DollarSign, Calendar, MessageSquare, Clock,
  GitBranch, ArrowRight, Flame, PhoneOff,
} from 'lucide-react'

function formatCurrency(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`
  return `$${n}`
}

function formatCount(n: number) {
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toLocaleString()
}

function leadName(lead: Record<string, any> | null | undefined) {
  if (!lead) return 'Unknown'
  return `${(lead.first_name as string) || ''} ${(lead.last_name as string) || ''}`.trim() || 'Unknown'
}

type Stage = { stage_id: string; name: string; stage_position: number; lead_count: number }

type Props = {
  userName: string
  kpis: {
    totalLeads: number
    weekLeads: number
    bookedThisWeek: number
    awaitingContact: number
    unreadThreads: number
    pipelineValue: number
  }
  stages: Stage[]
  upcomingConsults: Record<string, any>[]
  hotLeads: Record<string, any>[]
}

function Kpi({
  icon: Icon,
  label,
  value,
  href,
  tone,
}: {
  icon: typeof Users
  label: string
  value: string
  href?: string
  tone?: 'warn'
}) {
  const inner = (
    <div className="rounded-xl border border-aurea-border bg-aurea-surface px-4 py-3.5 transition-colors hover:bg-aurea-surface-2/60">
      <div className="flex items-center gap-2 text-aurea-ink-3">
        <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
        <span className="text-[11px] uppercase tracking-[0.08em]">{label}</span>
      </div>
      <p className={cn('mt-1.5 text-2xl font-semibold tabular-nums text-aurea-ink', tone === 'warn' && 'text-aurea-amber')}>
        {value}
      </p>
    </div>
  )
  return href ? <Link href={href}>{inner}</Link> : inner
}

// Proportional "leads by stage" funnel — the thing a practice admin asked to see.
function PipelineFunnel({ stages }: { stages: Stage[] }) {
  const max = Math.max(1, ...stages.map((s) => s.lead_count))
  return (
    <section className="rounded-xl border border-aurea-border bg-aurea-surface p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-aurea-ink-2" strokeWidth={1.75} />
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-aurea-ink-2">Leads by stage</h2>
        </div>
        <Link href="/pipeline" className="inline-flex items-center gap-1 text-[12px] text-aurea-primary hover:underline">
          Open pipeline <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
      {stages.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-aurea-ink-3">No pipeline stages configured.</p>
      ) : (
        <div className="space-y-2">
          {stages.map((s) => (
            <Link
              key={s.stage_id}
              href="/pipeline"
              className="group flex items-center gap-3"
            >
              <span className="w-40 shrink-0 truncate text-[12.5px] text-aurea-ink-2">{s.name}</span>
              <div className="relative h-5 flex-1 overflow-hidden rounded bg-aurea-surface-2">
                <div
                  className="h-full rounded bg-aurea-primary/25 transition-all group-hover:bg-aurea-primary/40"
                  style={{ width: `${Math.max(s.lead_count > 0 ? 3 : 0, (s.lead_count / max) * 100)}%` }}
                />
              </div>
              <span className="w-14 shrink-0 text-right text-[12.5px] font-medium tabular-nums text-aurea-ink">
                {formatCount(s.lead_count)}
              </span>
            </Link>
          ))}
        </div>
      )}
    </section>
  )
}

function ConsultRow({ consult }: { consult: Record<string, any> }) {
  const lead = consult.lead as Record<string, any> | null
  const when = consult.scheduled_at ? new Date(consult.scheduled_at) : null
  const confirmed = consult.status === 'confirmed' || consult.confirmation_received || consult.confirmed_at
  return (
    <Link
      href={lead?.id ? `/leads/${lead.id}` : '/appointments'}
      className="flex items-center gap-3 border-b border-aurea-border px-1 py-2.5 last:border-0 hover:bg-aurea-surface-2/60"
    >
      <div className="w-16 shrink-0 text-[11.5px] text-aurea-ink-3">
        {when ? (isTomorrow(when) ? 'Tmrw' : format(when, 'EEE')) : ''}
        <span className="block tabular-nums text-aurea-ink-2">{when ? format(when, 'h:mm a') : ''}</span>
      </div>
      <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-aurea-ink">{leadName(lead)}</p>
      <span
        className={cn(
          'shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-medium',
          confirmed ? 'text-aurea-primary' : 'text-aurea-amber'
        )}
      >
        {confirmed ? 'Confirmed' : 'Unconfirmed'}
      </span>
    </Link>
  )
}

function HotRow({ lead }: { lead: Record<string, any> }) {
  return (
    <Link
      href={`/leads/${lead.id}`}
      className="flex items-center gap-3 border-b border-aurea-border px-1 py-2.5 last:border-0 hover:bg-aurea-surface-2/60"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-aurea-rose/10 text-[11px] font-semibold tabular-nums text-aurea-rose ring-1 ring-aurea-rose/20">
        {lead.ai_score ?? '—'}
      </span>
      <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-aurea-ink">{leadName(lead)}</p>
      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-aurea-ink-3" />
    </Link>
  )
}

export function OpsDashboard({ userName, kpis, stages, upcomingConsults, hotLeads }: Props) {
  const today = new Date()
  return (
    <div className="space-y-5 animate-in fade-in-0 duration-500">
      {/* Header */}
      <div>
        <p className="text-[13px] text-aurea-ink-3">{format(today, 'EEEE, MMMM d')}</p>
        <h1 className="mt-0.5 text-[22px] font-semibold tracking-tight text-aurea-ink">Practice overview</h1>
        <p className="mt-1 text-[13px] text-aurea-ink-2">Where your leads sit and what&apos;s on the schedule, {userName}.</p>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Kpi icon={Users} label="Total leads" value={formatCount(kpis.totalLeads)} href="/leads" />
        <Kpi icon={TrendingUp} label="New this week" value={formatCount(kpis.weekLeads)} href="/leads" />
        <Kpi icon={Calendar} label="Consults this wk" value={formatCount(kpis.bookedThisWeek)} href="/appointments" />
        <Kpi icon={PhoneOff} label="Awaiting contact" value={formatCount(kpis.awaitingContact)} href="/leads" tone="warn" />
        <Kpi icon={MessageSquare} label="Unread threads" value={formatCount(kpis.unreadThreads)} href="/conversations" tone="warn" />
        <Kpi icon={DollarSign} label="Pipeline value" value={formatCurrency(kpis.pipelineValue)} href="/closing" />
      </div>

      {/* Pipeline funnel */}
      <PipelineFunnel stages={stages} />

      {/* Two columns: consults + hot leads */}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-aurea-border bg-aurea-surface p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-aurea-ink-2" strokeWidth={1.75} />
              <h2 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-aurea-ink-2">Consults this week</h2>
            </div>
            <Link href="/appointments" className="text-[12px] text-aurea-primary hover:underline">Calendar</Link>
          </div>
          {upcomingConsults.length === 0 ? (
            <p className="flex items-center gap-2 py-6 text-[13px] text-aurea-ink-3">
              <Clock className="h-4 w-4" strokeWidth={1.5} /> No consults booked this week.
            </p>
          ) : (
            <div>{upcomingConsults.map((c) => <ConsultRow key={c.id} consult={c} />)}</div>
          )}
        </section>

        <section className="rounded-xl border border-aurea-border bg-aurea-surface p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Flame className="h-4 w-4 text-aurea-rose" strokeWidth={1.75} />
              <h2 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-aurea-ink-2">Hot leads to work</h2>
            </div>
            <Link href="/leads?qualification=hot" className="text-[12px] text-aurea-primary hover:underline">All leads</Link>
          </div>
          {hotLeads.length === 0 ? (
            <p className="py-6 text-[13px] text-aurea-ink-3">No hot leads right now.</p>
          ) : (
            <div>{hotLeads.map((l) => <HotRow key={l.id} lead={l} />)}</div>
          )}
        </section>
      </div>
    </div>
  )
}
