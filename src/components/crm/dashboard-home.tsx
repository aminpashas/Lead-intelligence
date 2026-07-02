'use client'

/**
 * Dashboard home — the agent command center.
 *
 * The page's job is inverted from the classic CRM stats grid: instead of "here
 * are your numbers", it opens with what the AI did (brief), what it needs from
 * the human (decision queue), and what it's doing right now (activity feed).
 * The old seven KPI cards survive as a quiet chip strip at the bottom.
 *
 * Spec: docs/superpowers/specs/2026-07-02-ai-first-dashboard-design.md
 */

import Link from 'next/link'
import { format } from 'date-fns'
import { AskBar } from './dashboard/ask-bar'
import { DecisionQueue, type EscalationItem, type RiskyAppointmentItem, type StaleHotLeadItem } from './dashboard/decision-queue'
import { AgentActivity, type AgentActivityItem } from './dashboard/agent-activity'
import type { DailyBrief } from '@/lib/ai/daily-brief'
import { Bot, Phone } from 'lucide-react'

function formatCurrency(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`
  return `$${n}`
}

type DashboardProps = {
  userName: string
  orgId: string
  brief: DailyBrief
  autopilot: { enabled: boolean; paused: boolean; sendsToday: number }
  escalations: EscalationItem[]
  riskyAppointments: RiskyAppointmentItem[]
  staleHotLeads: StaleHotLeadItem[]
  aiActivities: AgentActivityItem[]
  todayAppointments: any[]
  watchingCount: number
  kpis: {
    totalLeads: number
    hotLeads: number
    converted: number
    pipelineValue: number
    weekLeads: number
    todayAppointments: number
    unreadMessages: number
  }
}

export function DashboardHome({
  userName,
  orgId,
  brief,
  autopilot,
  escalations,
  riskyAppointments,
  staleHotLeads,
  aiActivities,
  todayAppointments,
  watchingCount,
  kpis,
}: DashboardProps) {
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'

  const pilotState = !autopilot.enabled ? 'off' : autopilot.paused ? 'paused' : 'active'
  const pilotStyles: Record<string, string> = {
    active: 'bg-aurea-primary/10 text-aurea-primary ring-aurea-primary/20',
    paused: 'bg-aurea-amber/10 text-aurea-amber ring-aurea-amber/20',
    off: 'bg-aurea-surface-2 text-aurea-ink-3 ring-aurea-border',
  }
  const pilotLabel =
    pilotState === 'active'
      ? `Autopilot active · ${autopilot.sendsToday} send${autopilot.sendsToday === 1 ? '' : 's'} today`
      : pilotState === 'paused'
        ? 'Autopilot paused'
        : 'Autopilot off'

  return (
    <div className="animate-in fade-in-0 duration-500">
      {/* ── Header ─────────────────────────────────────────── */}
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-aurea-border pb-6">
        <div>
          <p className="aurea-eyebrow mb-2">Practice Dashboard</p>
          <h1 className="aurea-display text-[32px] text-aurea-ink sm:text-[40px]">
            {greeting}, {userName}
          </h1>
        </div>
        <Link
          href="/settings/ai"
          className={`inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[12.5px] font-medium ring-1 transition-opacity hover:opacity-80 ${pilotStyles[pilotState]}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${pilotState === 'active' ? 'bg-aurea-primary' : pilotState === 'paused' ? 'bg-aurea-amber' : 'bg-aurea-ink-3'}`} />
          {pilotLabel}
        </Link>
      </header>

      {/* ── Ask bar → command center ───────────────────────── */}
      <div className="mt-5">
        <AskBar userName={userName} />
      </div>

      {/* ── Today's brief ──────────────────────────────────── */}
      <section className="mt-5 rounded-2xl border border-aurea-border bg-aurea-surface-2 px-6 py-5">
        <div className="mb-2 flex items-center gap-2">
          <Bot className="h-4 w-4 text-aurea-ink-3" strokeWidth={1.75} />
          <p className="aurea-eyebrow">Today&apos;s brief</p>
        </div>
        <p className="aurea-display max-w-3xl text-[19px] leading-relaxed text-aurea-ink">
          {brief.text}
        </p>
      </section>

      {/* ── Decision queue + activity rail ─────────────────── */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <DecisionQueue
            escalations={escalations}
            riskyAppointments={riskyAppointments}
            staleHotLeads={staleHotLeads}
            watchingCount={watchingCount}
          />
        </div>

        <div className="space-y-5">
          <AgentActivity activities={aiActivities} orgId={orgId} />

          {/* Today's schedule */}
          <section className="aurea-card px-5 py-4">
            <h2 className="aurea-display mb-3 text-[18px] leading-tight text-aurea-ink">Today&apos;s schedule</h2>
            {todayAppointments.length === 0 ? (
              <p className="text-[13px] leading-relaxed text-aurea-ink-3">
                No appointments today.
              </p>
            ) : (
              todayAppointments.map((apt: any) => (
                <div key={apt.id} className="flex items-center justify-between gap-3 border-b border-aurea-border py-2.5 last:border-0">
                  <div className="flex items-center gap-3">
                    <p className="aurea-display w-16 text-[17px] tabular-nums text-aurea-amber">
                      {format(new Date(apt.scheduled_at), 'h:mma').toLowerCase()}
                    </p>
                    <div>
                      <p className="text-[13.5px] font-medium text-aurea-ink">
                        {apt.lead?.first_name} {apt.lead?.last_name}
                      </p>
                      <p className="text-[11.5px] capitalize text-aurea-ink-3">
                        {apt.type?.replace(/_/g, ' ')} · {apt.status}
                      </p>
                    </div>
                  </div>
                  {apt.lead?.phone && (
                    <a
                      href={`tel:${apt.lead.phone}`}
                      aria-label={`Call ${apt.lead.first_name || 'lead'}`}
                      className="flex h-7 w-7 items-center justify-center rounded-full text-aurea-ink-3 transition-colors hover:bg-aurea-surface-2 hover:text-aurea-ink"
                    >
                      <Phone className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </a>
                  )}
                </div>
              ))
            )}
          </section>
        </div>
      </div>

      {/* ── Metrics strip — demoted, not deleted ───────────── */}
      <div className="mt-8 flex flex-wrap gap-2 border-t border-aurea-border pt-5">
        <MetricChip label="leads" value={kpis.totalLeads} href="/leads" />
        <MetricChip label="hot" value={kpis.hotLeads} href="/leads?qualification=hot" />
        <MetricChip label="this week" value={`+${kpis.weekLeads}`} href="/leads" />
        <MetricChip label="converted" value={kpis.converted} href="/pipeline" />
        <MetricChip label="pipeline" value={formatCurrency(kpis.pipelineValue)} href="/pipeline" />
        <MetricChip label="appts today" value={kpis.todayAppointments} href="/appointments" />
        <MetricChip label="unread" value={kpis.unreadMessages} href="/conversations" alert={kpis.unreadMessages > 0} />
      </div>
    </div>
  )
}

function MetricChip({
  label,
  value,
  href,
  alert,
}: {
  label: string
  value: string | number
  href: string
  alert?: boolean
}) {
  return (
    <Link
      href={href}
      className="group inline-flex items-baseline gap-1.5 rounded-full border border-aurea-border bg-aurea-surface-2 px-3.5 py-1.5 transition-colors hover:border-aurea-ink-3"
    >
      <span className={`font-mono text-[13px] font-semibold tabular-nums ${alert ? 'text-aurea-rose' : 'text-aurea-ink'}`}>
        {value}
      </span>
      <span className="text-[12px] text-aurea-ink-3 transition-colors group-hover:text-aurea-ink-2">{label}</span>
    </Link>
  )
}
