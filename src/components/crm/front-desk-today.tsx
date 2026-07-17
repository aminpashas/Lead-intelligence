'use client'

import Link from 'next/link'
import { format, formatDistanceToNow, isToday, isTomorrow } from 'date-fns'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { leadDisplayName } from '@/lib/leads/display-name'
import {
  Calendar, Clock, MapPin, Phone, MessageSquare, ArrowRight,
  CheckCircle2, AlertCircle, Brain, ShieldAlert, Target, Sparkles,
} from 'lucide-react'

// Same monochrome-adjacent qualification palette as the command center.
const qualColors: Record<string, string> = {
  hot: 'bg-aurea-rose/10 text-aurea-rose border border-aurea-rose/20',
  warm: 'bg-aurea-amber/10 text-aurea-amber border border-aurea-amber/20',
  cold: 'bg-aurea-surface-2 text-aurea-ink-2 border border-aurea-border',
  unqualified: 'bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border',
  unscored: 'bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border',
}

const sentimentColors: Record<string, string> = {
  positive: 'text-aurea-primary',
  neutral: 'text-aurea-ink-3',
  negative: 'text-aurea-rose',
  frustrated: 'text-aurea-rose',
}

function formatCurrency(n: number) {
  if (!n) return null
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`
  return `$${n}`
}

function titleize(s?: string | null) {
  if (!s) return null
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function leadName(lead: Record<string, unknown> | null | undefined) {
  return leadDisplayName(lead as Parameters<typeof leadDisplayName>[0], 'Unknown patient')
}

type Consult = Record<string, any>

type Props = {
  userName: string
  todayConsults: Consult[]
  upcomingConsults: Consult[]
  stats: {
    todayCount: number
    confirmedCount: number
    needsConfirmationCount: number
    weekCount: number
  }
}

function StatTile({ label, value, tone }: { label: string; value: number; tone?: 'default' | 'warn' | 'good' }) {
  return (
    <div className="rounded-xl border border-aurea-border bg-aurea-surface px-4 py-3">
      <p
        className={cn(
          'text-2xl font-semibold tabular-nums',
          tone === 'warn' && value > 0 && 'text-aurea-amber',
          tone === 'good' && 'text-aurea-primary'
        )}
      >
        {value}
      </p>
      <p className="mt-0.5 text-[11px] uppercase tracking-[0.08em] text-aurea-ink-3">{label}</p>
    </div>
  )
}

function ConfirmationChip({ consult }: { consult: Consult }) {
  const confirmed = consult.status === 'confirmed' || consult.confirmation_received || consult.confirmed_at
  if (confirmed) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-aurea-primary">
        <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.75} /> Confirmed
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-aurea-amber">
      <AlertCircle className="h-3.5 w-3.5" strokeWidth={1.75} /> Not confirmed
    </span>
  )
}

// The "who's coming in" card — schedule fact on the left, AI prep on the right.
function ConsultCard({ consult }: { consult: Consult }) {
  const lead = consult.lead as Record<string, any> | null
  const when = consult.scheduled_at ? new Date(consult.scheduled_at) : null
  const qual = (lead?.ai_qualification as string) || 'unscored'
  const value = formatCurrency(lead?.treatment_value || 0)
  const noShowRisk = typeof consult.no_show_risk_score === 'number' ? consult.no_show_risk_score : null
  const highRisk = noShowRisk !== null && noShowRisk >= 0.6

  return (
    <div className="rounded-xl border border-aurea-border bg-aurea-surface overflow-hidden">
      <div className="grid gap-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        {/* Left: the appointment fact */}
        <div className="p-4 md:border-r border-aurea-border">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[15px] font-semibold text-aurea-ink truncate">{leadName(lead)}</p>
              <p className="mt-0.5 text-[13px] text-aurea-ink-2">{titleize(consult.type) || 'Consultation'}</p>
            </div>
            {when && (
              <div className="text-right shrink-0">
                <p className="text-[15px] font-semibold tabular-nums text-aurea-ink">{format(when, 'h:mm a')}</p>
                {consult.duration_minutes ? (
                  <p className="text-[11px] text-aurea-ink-3">{consult.duration_minutes} min</p>
                ) : null}
              </div>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <ConfirmationChip consult={consult} />
            {consult.location && (
              <span className="inline-flex items-center gap-1 text-[11px] text-aurea-ink-3">
                <MapPin className="h-3.5 w-3.5" strokeWidth={1.75} /> {consult.location}
              </span>
            )}
            {highRisk && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-aurea-rose">
                <ShieldAlert className="h-3.5 w-3.5" strokeWidth={1.75} /> No-show risk
              </span>
            )}
          </div>

          <div className="mt-3 flex items-center gap-2">
            {lead?.id && (
              <Link
                href={`/leads/${lead.id}`}
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-8 text-[12px]')}
              >
                Open patient <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Link>
            )}
            {lead?.phone && !String(lead.phone).startsWith('enc::') && (
              <a
                href={`tel:${lead.phone}`}
                className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'h-8 text-[12px]')}
              >
                <Phone className="mr-1 h-3.5 w-3.5" /> Call
              </a>
            )}
          </div>
        </div>

        {/* Right: the AI prep — what to know before they walk in */}
        <div className="p-4 bg-aurea-surface-2/40">
          <div className="flex items-center gap-2">
            <span className={cn('inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium capitalize', qualColors[qual])}>
              {qual}
              {typeof lead?.ai_score === 'number' ? ` · ${lead.ai_score}` : ''}
            </span>
            {value && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-aurea-ink-2">
                <Target className="h-3.5 w-3.5" strokeWidth={1.75} /> {value} est.
              </span>
            )}
          </div>

          {lead?.ai_summary ? (
            <p className="mt-2.5 flex gap-2 text-[12.5px] leading-relaxed text-aurea-ink-2">
              <Brain className="mt-0.5 h-3.5 w-3.5 shrink-0 text-aurea-primary" strokeWidth={1.75} />
              <span className="line-clamp-3">{lead.ai_summary}</span>
            </p>
          ) : (
            <p className="mt-2.5 text-[12.5px] text-aurea-ink-3">No AI summary yet.</p>
          )}

          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
            {lead?.conversation_intent && (
              <span className="text-aurea-ink-3">
                Intent: <span className="text-aurea-ink-2 font-medium">{titleize(lead.conversation_intent)}</span>
              </span>
            )}
            {lead?.conversation_sentiment && (
              <span className="text-aurea-ink-3">
                Mood:{' '}
                <span className={cn('font-medium', sentimentColors[String(lead.conversation_sentiment)] || 'text-aurea-ink-2')}>
                  {titleize(lead.conversation_sentiment)}
                </span>
              </span>
            )}
            {lead?.primary_objection && (
              <span className="text-aurea-ink-3">
                Objection: <span className="text-aurea-ink-2 font-medium">{titleize(lead.primary_objection)}</span>
              </span>
            )}
          </div>

          {lead?.conversation_red_flag && (
            <div className="mt-2.5 flex items-start gap-1.5 rounded-md border border-aurea-rose/20 bg-aurea-rose/5 px-2.5 py-1.5 text-[11.5px] text-aurea-rose">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
              <span>{typeof lead.conversation_red_flag === 'string' ? lead.conversation_red_flag : 'Flagged in conversation — review before the visit.'}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function UpcomingRow({ consult }: { consult: Consult }) {
  const lead = consult.lead as Record<string, any> | null
  const when = consult.scheduled_at ? new Date(consult.scheduled_at) : null
  return (
    <Link
      href={lead?.id ? `/leads/${lead.id}` : '/appointments'}
      className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-aurea-surface-2/60 transition-colors"
    >
      <div className="w-20 shrink-0 text-[12px] text-aurea-ink-3">
        {when ? (isTomorrow(when) ? 'Tomorrow' : format(when, 'EEE')) : ''}
        <span className="block tabular-nums text-aurea-ink-2">{when ? format(when, 'h:mm a') : ''}</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-aurea-ink truncate">{leadName(lead)}</p>
        <p className="text-[11px] text-aurea-ink-3 truncate">{titleize(consult.type) || 'Consultation'}</p>
      </div>
      <ConfirmationChip consult={consult} />
    </Link>
  )
}

export function FrontDeskToday({ userName, todayConsults, upcomingConsults, stats }: Props) {
  const today = new Date()
  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <p className="text-[13px] text-aurea-ink-3">{format(today, 'EEEE, MMMM d')}</p>
        <h1 className="mt-0.5 text-[22px] font-semibold tracking-tight text-aurea-ink">
          Good {today.getHours() < 12 ? 'morning' : today.getHours() < 18 ? 'afternoon' : 'evening'}, {userName}
        </h1>
        <p className="mt-1 flex items-center gap-1.5 text-[13px] text-aurea-ink-2">
          <Sparkles className="h-3.5 w-3.5 text-aurea-primary" strokeWidth={1.75} />
          {stats.todayCount === 0
            ? 'No consults booked for today.'
            : `${stats.todayCount} consult${stats.todayCount === 1 ? '' : 's'} on the schedule today.`}
        </p>
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Today" value={stats.todayCount} />
        <StatTile label="Confirmed" value={stats.confirmedCount} tone="good" />
        <StatTile label="Needs confirming" value={stats.needsConfirmationCount} tone="warn" />
        <StatTile label="This week" value={stats.weekCount} />
      </div>

      {/* Today's consults */}
      <section>
        <div className="mb-2.5 flex items-center gap-2">
          <Calendar className="h-4 w-4 text-aurea-ink-2" strokeWidth={1.75} />
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-aurea-ink-2">Today&apos;s consults</h2>
        </div>
        {todayConsults.length === 0 ? (
          <div className="rounded-xl border border-dashed border-aurea-border bg-aurea-surface px-4 py-10 text-center">
            <Clock className="mx-auto h-6 w-6 text-aurea-ink-3" strokeWidth={1.5} />
            <p className="mt-2 text-[13px] text-aurea-ink-2">Nothing on the books today.</p>
            <p className="text-[12px] text-aurea-ink-3">Upcoming consults appear below as they&apos;re booked.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {todayConsults.map((c) => (
              <ConsultCard key={c.id} consult={c} />
            ))}
          </div>
        )}
      </section>

      {/* Upcoming this week */}
      {upcomingConsults.length > 0 && (
        <section>
          <div className="mb-1.5 flex items-center justify-between">
            <h2 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-aurea-ink-2">Coming up this week</h2>
            <Link href="/appointments" className="text-[12px] text-aurea-primary hover:underline">
              Full calendar
            </Link>
          </div>
          <div className="rounded-xl border border-aurea-border bg-aurea-surface divide-y divide-aurea-border">
            {upcomingConsults.map((c) => (
              <UpcomingRow key={c.id} consult={c} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
