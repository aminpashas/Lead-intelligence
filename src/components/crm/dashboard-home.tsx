'use client'

import Link from 'next/link'
import { formatDistanceToNow, format } from 'date-fns'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CommandCenter } from './command-center'
import {
  Users, TrendingUp, DollarSign, Calendar, MessageSquare,
  ArrowRight, Clock, Phone, Mail, Zap, Brain, Bell,
  CheckCircle2, AlertCircle, UserPlus, Megaphone, type LucideIcon,
} from 'lucide-react'

// Lead qualification chips — kept monochrome-adjacent: urgency reads rose,
// warmth reads amber, everything cooler is neutral ink. No blue/purple.
const qualColors: Record<string, string> = {
  hot: 'bg-aurea-rose/10 text-aurea-rose border border-aurea-rose/20',
  warm: 'bg-aurea-amber/10 text-aurea-amber border border-aurea-amber/20',
  cold: 'bg-aurea-surface-2 text-aurea-ink-2 border border-aurea-border',
  unqualified: 'bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border',
  unscored: 'bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border',
}

// Activity glyphs — a single emerald accent for the positive beats, amber for
// scheduling, rose for disqualification; the rest stay quiet ink.
const activityIcons: Record<string, React.ReactNode> = {
  lead_created: <UserPlus className="h-3.5 w-3.5 text-aurea-primary" strokeWidth={1.75} />,
  status_changed: <TrendingUp className="h-3.5 w-3.5 text-aurea-ink-3" strokeWidth={1.75} />,
  message_sent: <MessageSquare className="h-3.5 w-3.5 text-aurea-ink-3" strokeWidth={1.75} />,
  message_received: <MessageSquare className="h-3.5 w-3.5 text-aurea-primary" strokeWidth={1.75} />,
  appointment_scheduled: <Calendar className="h-3.5 w-3.5 text-aurea-amber" strokeWidth={1.75} />,
  ai_scored: <Brain className="h-3.5 w-3.5 text-aurea-primary" strokeWidth={1.75} />,
  disqualified: <AlertCircle className="h-3.5 w-3.5 text-aurea-rose" strokeWidth={1.75} />,
  campaign_enrolled: <Megaphone className="h-3.5 w-3.5 text-aurea-amber" strokeWidth={1.75} />,
}

function formatCurrency(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`
  return `$${n}`
}

// Large lead counts read better abbreviated (45,148 → 45.1k).
function formatCount(n: number) {
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toLocaleString()
}

// Week-over-week context line for the new-leads card. Prior-week volume can be
// tiny (or zero), so show the raw baseline rather than a misleading percentage.
function weekTrend(current: number, previous: number) {
  if (previous === 0) return current > 0 ? 'none prior week' : 'past 7 days'
  const pct = Math.round(((current - previous) / previous) * 100)
  const arrow = pct >= 0 ? '↑' : '↓'
  return `${arrow} ${Math.abs(pct)}% vs ${previous} prior wk`
}

type DashboardProps = {
  userName: string
  hotLeads: any[]
  todayAppointments: any[]
  recentLeads: any[]
  unreadConversations: any[]
  activeCampaigns: any[]
  recentActivities: any[]
  kpis: {
    totalLeads: number
    weekLeads: number
    prevWeekLeads: number
    awaitingContact: number
    engaged: number
    pipelineValue: number
    upcomingAppointments: number
    unreadThreads: number
  }
}

export function DashboardHome({
  userName,
  hotLeads,
  todayAppointments,
  recentLeads,
  unreadConversations,
  activeCampaigns,
  recentActivities,
  kpis,
}: DashboardProps) {
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'

  return (
    <div className="animate-in fade-in-0 duration-500">
      {/* ── Header ─────────────────────────────────────────── */}
      <header className="border-b border-aurea-border pb-8">
        <p className="aurea-eyebrow mb-3">Practice Dashboard</p>
        <h1 className="aurea-display text-[36px] text-aurea-ink sm:text-[46px]">
          {greeting}, {userName}
        </h1>
        <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-aurea-ink-2">
          Ask your AI agent below to run outreach, follow up with a group, or answer
          questions about your pipeline.
        </p>
      </header>

      {/* ── KPI Row ──────────────────────────────────────────
          Every card is a real Postgres aggregate (no sampled rows) and deep-links
          to a view filtered to EXACTLY the rows it counted — same predicate, same
          window — not the unfiltered screen. `include=all` on the lead links keeps
          the list from hiding off-funnel stages the count didn't hide. Metrics that
          are structurally frozen for this book (Converted, Hot) don't get a slot. */}
      <div className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
        <MiniKPI
          icon={TrendingUp}
          label="New Ad Leads"
          value={`+${kpis.weekLeads}`}
          sub={weekTrend(kpis.weekLeads, kpis.prevWeekLeads)}
          accent="emerald"
          href="/leads?channel=paid&range=7d&include=all&sort=created&dir=desc"
        />
        <MiniKPI
          icon={AlertCircle}
          label="Not Contacted"
          value={kpis.awaitingContact}
          sub="new this week"
          accent={kpis.awaitingContact > 0 ? 'rose' : undefined}
          href="/leads?channel=paid&range=7d&contacted=never&include=all&sort=created&dir=desc"
        />
        <MiniKPI
          icon={MessageSquare}
          label="Replied · 7d"
          value={kpis.engaged}
          sub="leads engaged"
          accent={kpis.engaged > 0 ? 'emerald' : undefined}
          href="/leads?responded=7d&include=all&sort=created&dir=desc"
        />
        <MiniKPI
          icon={Calendar}
          label="Appts · 7d"
          value={kpis.upcomingAppointments}
          sub="on the books"
          accent="amber"
          href="/appointments?window=7d"
        />
        <MiniKPI
          icon={DollarSign}
          label="Pipeline"
          value={formatCurrency(kpis.pipelineValue)}
          sub="est. treatment value"
          accent="emerald"
          href="/pipeline"
        />
        <MiniKPI
          icon={Bell}
          label="Unread"
          value={kpis.unreadThreads}
          sub="conversations"
          accent={kpis.unreadThreads > 0 ? 'rose' : undefined}
          href="/conversations?filter=unread"
        />
        <MiniKPI
          icon={Users}
          label="Database"
          value={formatCount(kpis.totalLeads)}
          sub="total leads"
          href="/leads?include=all"
        />
      </div>

      {/* ── Command center (hero) + priority rail ──────────── */}
      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <CommandCenter userName={userName} />
        </div>

        <div className="space-y-5">
          {/* Unread Messages */}
          {unreadConversations.length > 0 && (
            <section className="aurea-card overflow-hidden">
              <div className="flex items-center gap-2 border-b border-aurea-border px-5 py-4">
                <span className="flex h-1.5 w-1.5 rounded-full bg-aurea-rose" />
                <h2 className="aurea-display text-[18px] text-aurea-ink">
                  Unread Messages
                </h2>
                <span className="font-mono text-[12px] tabular-nums text-aurea-ink-3">
                  ({kpis.unreadThreads})
                </span>
              </div>
              <div className="px-5">
                {unreadConversations.map((convo: any) => (
                  <Link
                    key={convo.id}
                    href={`/conversations/${convo.id}`}
                    className="flex items-center justify-between gap-3 border-b border-aurea-border py-3 transition-colors last:border-0 hover:bg-aurea-surface-2 -mx-5 px-5"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-aurea-rose/10 px-1 text-[11px] font-semibold tabular-nums text-aurea-rose ring-1 ring-aurea-rose/20">
                        {convo.unread_count}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-[14px] font-medium text-aurea-ink">
                          {convo.lead?.first_name} {convo.lead?.last_name}
                        </p>
                        <p className="max-w-xs truncate text-[12px] text-aurea-ink-3">
                          {convo.last_message_preview}
                        </p>
                      </div>
                    </div>
                    <span className="shrink-0 font-mono text-[11px] text-aurea-ink-3">
                      {convo.last_message_at
                        ? formatDistanceToNow(new Date(convo.last_message_at), { addSuffix: true })
                        : ''}
                    </span>
                  </Link>
                ))}
                <Link
                  href="/conversations"
                  className="group flex items-center justify-center gap-1.5 py-3 text-[12px] font-medium text-aurea-ink-2 transition-colors hover:text-aurea-ink"
                >
                  View all conversations
                  <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                </Link>
              </div>
            </section>
          )}

          {/* Hot Leads */}
          <SectionCard
            title="Hot Leads"
            subtitle="Priority follow-up"
            dot="rose"
            action={{ label: 'View all', href: '/leads?qualification=hot' }}
          >
            {hotLeads.length === 0 ? (
              <EmptyRow>No hot leads right now. Keep nurturing.</EmptyRow>
            ) : (
              hotLeads.slice(0, 6).map((lead: any) => {
                const needsAction = !lead.last_responded_at && lead.last_contacted_at
                const neverContacted = !lead.last_contacted_at
                return (
                  <Link
                    key={lead.id}
                    href={`/leads/${lead.id}`}
                    className="-mx-5 flex items-center justify-between gap-3 border-b border-aurea-border px-5 py-3 transition-colors last:border-0 hover:bg-aurea-surface-2"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-aurea-rose/10 text-[12px] font-semibold tabular-nums text-aurea-rose ring-1 ring-aurea-rose/20">
                        {lead.ai_score}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-[14px] font-medium text-aurea-ink">
                          {lead.first_name} {lead.last_name}
                        </p>
                        <div className="flex items-center gap-2 text-[12px] text-aurea-ink-3">
                          <span className="capitalize">{lead.status.replace(/_/g, ' ')}</span>
                          {lead.phone && <Phone className="h-3 w-3" strokeWidth={1.75} />}
                          {lead.email && <Mail className="h-3 w-3" strokeWidth={1.75} />}
                        </div>
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      {neverContacted && (
                        <span className="inline-flex items-center rounded-md bg-aurea-rose/10 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-aurea-rose ring-1 ring-aurea-rose/20">
                          New — Contact Now
                        </span>
                      )}
                      {needsAction && (
                        <span className="inline-flex items-center gap-1 rounded-md bg-aurea-amber/10 px-2 py-0.5 text-[10.5px] font-medium text-aurea-amber ring-1 ring-aurea-amber/20">
                          <Clock className="h-3 w-3" strokeWidth={1.75} />
                          Awaiting reply
                        </span>
                      )}
                      {lead.last_responded_at && (
                        <span className="font-mono text-[11px] text-aurea-ink-3">
                          Replied {formatDistanceToNow(new Date(lead.last_responded_at), { addSuffix: true })}
                        </span>
                      )}
                    </div>
                  </Link>
                )
              })
            )}
          </SectionCard>

          {/* Today's Appointments */}
          <SectionCard
            title="Today's Appointments"
            subtitle={`${todayAppointments.length} scheduled`}
            dot="amber"
            action={{ label: 'View all', href: '/appointments' }}
          >
            {todayAppointments.length === 0 ? (
              <EmptyRow>No appointments today.</EmptyRow>
            ) : (
              todayAppointments.map((apt: any) => (
                <div
                  key={apt.id}
                  className="-mx-5 flex items-center justify-between gap-3 border-b border-aurea-border px-5 py-3 last:border-0"
                >
                  <div className="flex items-center gap-3.5">
                    <div className="text-center leading-none">
                      <p className="aurea-display text-[22px] tabular-nums text-aurea-amber">
                        {format(new Date(apt.scheduled_at), 'h:mm')}
                      </p>
                      <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wide text-aurea-ink-3">
                        {format(new Date(apt.scheduled_at), 'a')}
                      </p>
                    </div>
                    <div>
                      <p className="text-[14px] font-medium text-aurea-ink">
                        {apt.lead?.first_name} {apt.lead?.last_name}
                      </p>
                      <p className="text-[12px] capitalize text-aurea-ink-3">{apt.type}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium capitalize">
                      <span className={`h-1.5 w-1.5 rounded-full ${apt.status === 'confirmed' ? 'bg-aurea-primary' : 'bg-aurea-ink-3'}`} />
                      <span className={apt.status === 'confirmed' ? 'text-aurea-primary' : 'text-aurea-ink-3'}>
                        {apt.status}
                      </span>
                    </span>
                    {apt.lead?.phone && (
                      <a href={`tel:${apt.lead.phone}`}>
                        <Button variant="outline" size="icon" className="h-7 w-7">
                          <Phone className="h-3 w-3" strokeWidth={1.75} />
                        </Button>
                      </a>
                    )}
                  </div>
                </div>
              ))
            )}
          </SectionCard>
        </div>
      </div>

      {/* ── Secondary row — new leads, campaigns, activity ──── */}
      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* Recent Leads */}
        <SectionCard
            title="New Leads"
            subtitle="Last 48 hours"
            dot="emerald"
            action={{ label: 'View all', href: '/leads' }}
          >
            {recentLeads.length === 0 ? (
              <EmptyRow>No new leads in the last 48 hours.</EmptyRow>
            ) : (
              recentLeads.map((lead: any) => (
                <Link
                  key={lead.id}
                  href={`/leads/${lead.id}`}
                  className="-mx-5 flex items-center justify-between gap-3 border-b border-aurea-border px-5 py-3 transition-colors last:border-0 hover:bg-aurea-surface-2"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className={`inline-flex h-7 min-w-7 items-center justify-center rounded-full px-1 text-[11px] font-semibold tabular-nums ${qualColors[lead.ai_qualification] ?? qualColors.unscored}`}>
                      {lead.ai_score}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-[14px] font-medium text-aurea-ink">
                        {lead.first_name} {lead.last_name}
                      </p>
                      <p className="truncate text-[12px] capitalize text-aurea-ink-3">
                        {lead.source_type?.replace(/_/g, ' ') || 'unknown'} &middot; {lead.status.replace(/_/g, ' ')}
                      </p>
                    </div>
                  </div>
                  <span className="shrink-0 font-mono text-[11px] text-aurea-ink-3">
                    {formatDistanceToNow(new Date(lead.created_at), { addSuffix: true })}
                  </span>
                </Link>
              ))
            )}
          </SectionCard>

        {/* Active Campaigns */}
        <SectionCard
            title="Active Campaigns"
            dot="amber"
            action={{ label: 'Manage', href: '/campaigns' }}
          >
            {activeCampaigns.length === 0 ? (
              <div className="py-6 text-center">
                <p className="mb-3 text-[13px] text-aurea-ink-3">No active campaigns</p>
                <Link href="/campaigns">
                  <Button variant="outline" size="sm" className="gap-1.5">
                    <Zap className="h-3.5 w-3.5" strokeWidth={1.75} /> Deploy a Campaign
                  </Button>
                </Link>
              </div>
            ) : (
              activeCampaigns.map((c: any) => (
                <div key={c.id} className="border-b border-aurea-border py-3 last:border-0">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <p className="truncate text-[14px] font-medium text-aurea-ink">{c.name}</p>
                    <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-aurea-ink-3">
                      {c.channel}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 font-mono text-[11px] tabular-nums text-aurea-ink-3">
                    <span>{c.total_enrolled} enrolled</span>
                    <span>{c.total_converted} converted</span>
                  </div>
                </div>
              ))
            )}
          </SectionCard>

          {/* Activity Feed */}
          <SectionCard title="Recent Activity">
            {recentActivities.length === 0 ? (
              <EmptyRow>No recent activity.</EmptyRow>
            ) : (
              <div className="space-y-3 py-1">
                {recentActivities.map((act: any) => (
                  <div key={act.id} className="flex items-start gap-2.5">
                    <div className="mt-0.5 shrink-0">
                      {activityIcons[act.activity_type] || <CheckCircle2 className="h-3.5 w-3.5 text-aurea-ink-3" strokeWidth={1.75} />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[12.5px] text-aurea-ink-2">
                        <span className="font-medium text-aurea-ink">
                          {act.lead?.first_name} {act.lead?.last_name}
                        </span>
                        {' '}&mdash; {act.title}
                      </p>
                      <p className="font-mono text-[11px] text-aurea-ink-3">
                        {formatDistanceToNow(new Date(act.created_at), { addSuffix: true })}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>

      </div>
    </div>
  )
}

/* ── Primitives ─────────────────────────────────────────── */

const dotColor: Record<string, string> = {
  emerald: 'bg-aurea-primary',
  amber: 'bg-aurea-amber',
  rose: 'bg-aurea-rose',
}

function SectionCard({
  title,
  subtitle,
  dot,
  action,
  children,
}: {
  title: string
  subtitle?: string
  dot?: 'emerald' | 'amber' | 'rose'
  action?: { label: string; href: string }
  children: React.ReactNode
}) {
  return (
    <section className="aurea-card overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-aurea-border px-5 py-4">
        <div className="flex items-center gap-2">
          {dot && <span className={`h-1.5 w-1.5 rounded-full ${dotColor[dot]}`} />}
          <div>
            <h2 className="aurea-display text-[18px] leading-tight text-aurea-ink">{title}</h2>
            {subtitle && <p className="text-[12px] text-aurea-ink-3">{subtitle}</p>}
          </div>
        </div>
        {action && (
          <Link
            href={action.href}
            className="group inline-flex shrink-0 items-center gap-1.5 text-[12px] font-medium text-aurea-ink-2 transition-colors hover:text-aurea-ink"
          >
            {action.label}
            <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
          </Link>
        )}
      </div>
      <div className="px-5">{children}</div>
    </section>
  )
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return <p className="py-8 text-center text-[13px] text-aurea-ink-3">{children}</p>
}

function MiniKPI({
  icon: Icon,
  label,
  value,
  sub,
  accent,
  href,
}: {
  icon: LucideIcon
  label: string
  value: string | number
  sub?: string
  accent?: 'emerald' | 'amber' | 'rose'
  href?: string
}) {
  const valueColor =
    accent === 'emerald' ? 'text-aurea-primary'
    : accent === 'amber' ? 'text-aurea-amber'
    : accent === 'rose' ? 'text-aurea-rose'
    : 'text-aurea-ink'
  const body = (
    <>
      <div className="flex items-center justify-between">
        <p className="aurea-eyebrow">{label}</p>
        <Icon className="h-[15px] w-[15px] text-aurea-ink-3" strokeWidth={1.75} />
      </div>
      <p className={`mt-3 aurea-display text-[26px] tabular-nums ${valueColor}`}>{value}</p>
      {sub && (
        <p className="mt-1 truncate text-[11px] leading-tight text-aurea-ink-3">{sub}</p>
      )}
    </>
  )
  if (href) {
    return (
      <Link href={href} className="aurea-card block p-4 transition-colors hover:bg-aurea-surface-2">
        {body}
      </Link>
    )
  }
  return <div className="aurea-card p-4">{body}</div>
}
