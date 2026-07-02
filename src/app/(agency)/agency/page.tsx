import { createClient } from '@/lib/supabase/server'
import {
  Building2,
  Users,
  Brain,
  MessagesSquare,
  Plug,
  GraduationCap,
  ArrowRight,
  ArrowUpRight,
  DollarSign,
} from 'lucide-react'
import Link from 'next/link'
import { loadAgencySpend, formatUsd, marginPct } from '@/lib/billing/spend-summary'

export const metadata = {
  title: 'Agency Home | Lead Intelligence',
}

function initialsOf(name: string) {
  return name
    .split(' ')
    .map((w) => w[0])
    .filter(Boolean)
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

export default async function AgencyHomePage() {
  const supabase = await createClient()

  // Fetch all organizations (agency_admin RLS allows this), excluding the
  // agency's own home org — that's the agency itself, not a client practice.
  const { data: { user } } = await supabase.auth.getUser()
  const { data: me } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .eq('id', user?.id ?? '')
    .single()
  const agencyOrgId = me?.organization_id ?? null

  const { data: allOrgs } = await supabase
    .from('organizations')
    .select('id, name, slug, subscription_tier, subscription_status, created_at')
    .order('created_at', { ascending: false })

  const organizations = (allOrgs ?? []).filter((o) => o.id !== agencyOrgId)

  // Fetch aggregate stats
  const { count: totalLeads } = await supabase
    .from('leads')
    .select('id', { count: 'exact', head: true })

  const { count: totalConversations } = await supabase
    .from('conversations')
    .select('id', { count: 'exact', head: true })

  const { data: agencySettings } = await supabase
    .from('agency_settings')
    .select('key, value')

  const aiModelSetting = agencySettings?.find((s) => s.key === 'ai_model')
  const aiPersonaSetting = agencySettings?.find((s) => s.key === 'ai_persona')
  const aiModel = aiModelSetting?.value as { model?: string } | undefined
  const aiPersona = aiPersonaSetting?.value as { name?: string } | undefined

  // Blended spend across all practices (30d): what we pay providers vs. what we re-bill.
  const { summary: spend } = await loadAgencySpend(supabase, { sinceDays: 30 })

  const practiceCount = organizations?.length ?? 0
  const activeCount = organizations?.filter((o) => o.subscription_status === 'active').length ?? 0
  const personaName = aiPersona?.name ?? 'Aria'

  const kpis: {
    index: string
    label: string
    value: string
    sub: string
    progress?: number
    icon: typeof Building2
  }[] = [
    {
      index: '01',
      label: 'Active Practices',
      value: activeCount.toLocaleString(),
      sub: `of ${practiceCount} total`,
      progress: practiceCount > 0 ? activeCount / practiceCount : 0,
      icon: Building2,
    },
    {
      index: '02',
      label: 'Total Leads',
      value: (totalLeads ?? 0).toLocaleString(),
      sub: 'across all practices',
      icon: Users,
    },
    {
      index: '03',
      label: 'Conversations',
      value: (totalConversations ?? 0).toLocaleString(),
      sub: 'AI-assisted threads',
      icon: MessagesSquare,
    },
    {
      index: '04',
      label: 'AI Agent',
      value: personaName,
      sub: 'Active persona',
      icon: Brain,
    },
  ]

  const platformStatus = [
    { label: 'AI Model', value: aiModel?.model ?? 'claude-3-5-sonnet-20241022', ok: true },
    { label: 'Agent Persona', value: personaName, ok: true },
    { label: 'Anthropic API', value: process.env.ANTHROPIC_API_KEY ? 'Connected' : 'Not configured', ok: !!process.env.ANTHROPIC_API_KEY },
    { label: 'Twilio SMS', value: process.env.TWILIO_ACCOUNT_SID ? 'Connected' : 'Not configured', ok: !!process.env.TWILIO_ACCOUNT_SID },
    { label: 'Resend Email', value: process.env.RESEND_API_KEY ? 'Connected' : 'Not configured', ok: !!process.env.RESEND_API_KEY },
  ]
  const attention = platformStatus.filter((s) => !s.ok).length

  const quickActions: { label: string; desc: string; href: string; icon: typeof Building2 }[] = [
    { label: 'Manage Practices', desc: 'Onboard & configure', href: '/agency/practices', icon: Building2 },
    { label: 'AI Configuration', desc: 'Model & persona', href: '/agency/ai-config', icon: Brain },
    { label: 'Spend & Margin', desc: 'Cost & re-billing', href: '/agency/spend', icon: DollarSign },
    { label: 'Integrations', desc: 'Channels & keys', href: '/agency/integrations', icon: Plug },
    { label: 'AI Training', desc: 'Tune responses', href: '/agency/ai-training', icon: GraduationCap },
  ]

  return (
    <div className="animate-in fade-in-0 duration-500">
      {/* ── Header ─────────────────────────────────────────── */}
      <header className="flex flex-col gap-5 border-b border-aurea-border pb-8 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="aurea-eyebrow mb-3">Platform Overview</p>
          <h1 className="aurea-display text-[40px] text-aurea-ink sm:text-[52px]">
            Agency Control Panel
          </h1>
          <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-aurea-ink-2">
            Manage every practice, your AI configuration, and platform-wide settings — one quiet
            command center for the whole network.
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className={`h-1.5 w-1.5 rounded-full ${attention === 0 ? 'bg-aurea-primary' : 'bg-aurea-amber'}`} />
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-aurea-ink-3">
            {attention === 0 ? 'All systems operational' : `${attention} need attention`}
          </span>
        </div>
      </header>

      {/* ── KPI grid ───────────────────────────────────────── */}
      <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((kpi) => (
          <div key={kpi.label} className="aurea-card p-5">
            <div className="flex items-center justify-between">
              <p className="aurea-eyebrow">{kpi.label}</p>
              <span className="font-mono text-[11px] tabular-nums text-aurea-ink-3">/{kpi.index}</span>
            </div>
            <div className="mt-4 flex items-end justify-between">
              <p className="aurea-display text-[40px] tabular-nums text-aurea-ink">{kpi.value}</p>
              <kpi.icon className="mb-1.5 h-[18px] w-[18px] text-aurea-ink-3" strokeWidth={1.75} />
            </div>
            {kpi.progress !== undefined ? (
              <div className="mt-4">
                <div className="h-[3px] w-full overflow-hidden rounded-full bg-aurea-surface-2">
                  <div
                    className="h-full rounded-full bg-aurea-primary"
                    style={{ width: `${Math.round(kpi.progress * 100)}%` }}
                  />
                </div>
                <p className="mt-2 text-[11.5px] text-aurea-ink-3">{kpi.sub}</p>
              </div>
            ) : (
              <p className="mt-3 text-[11.5px] text-aurea-ink-3">{kpi.sub}</p>
            )}
          </div>
        ))}
      </div>

      {/* ── Spend summary (30d) ────────────────────────────── */}
      <Link
        href="/agency/spend"
        className="group mt-5 flex flex-col gap-4 rounded-[var(--aurea-radius,12px)] border border-aurea-border bg-aurea-surface p-5 transition-colors hover:bg-aurea-surface-2 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="flex items-center gap-3">
          <DollarSign className="h-[18px] w-[18px] text-aurea-ink-2" strokeWidth={1.75} />
          <div>
            <p className="aurea-eyebrow">Spend &amp; Margin — Last 30 Days</p>
            <p className="mt-0.5 text-[12px] text-aurea-ink-3">Anthropic + Twilio + Retell, across all practices</p>
          </div>
        </div>
        <div className="flex items-center gap-6">
          <div>
            <p className="font-mono text-[18px] tabular-nums text-aurea-ink">{formatUsd(spend.totalCostCents)}</p>
            <p className="text-[10.5px] uppercase tracking-[0.12em] text-aurea-ink-3">Cost</p>
          </div>
          <div>
            <p className="font-mono text-[18px] tabular-nums text-aurea-ink">{formatUsd(spend.totalBillableCents)}</p>
            <p className="text-[10.5px] uppercase tracking-[0.12em] text-aurea-ink-3">Billable</p>
          </div>
          <div>
            <p className="font-mono text-[18px] tabular-nums text-aurea-primary">+{formatUsd(spend.marginCents)}</p>
            <p className="text-[10.5px] uppercase tracking-[0.12em] text-aurea-ink-3">Margin · {marginPct(spend).toFixed(0)}%</p>
          </div>
          <ArrowRight className="hidden h-4 w-4 shrink-0 text-aurea-ink-3 transition-transform group-hover:translate-x-0.5 sm:block" />
        </div>
      </Link>

      {/* ── Practices + AI Platform ────────────────────────── */}
      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* Practices */}
        <section className="aurea-card overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-aurea-border px-5 py-4">
            <div>
              <h2 className="aurea-display text-[22px] text-aurea-ink">Practices</h2>
              <p className="mt-0.5 text-[12px] text-aurea-ink-3">All customer practices on the platform</p>
            </div>
            <Link
              href="/agency/practices"
              className="group inline-flex items-center gap-1.5 text-[12px] font-medium text-aurea-ink-2 transition-colors hover:text-aurea-ink"
            >
              View all
              <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </div>
          <div className="px-5">
            {organizations && organizations.length > 0 ? (
              organizations.slice(0, 5).map((org) => {
                const active = org.subscription_status === 'active'
                return (
                  <div
                    key={org.id}
                    className="flex items-center justify-between gap-3 border-b border-aurea-border py-3.5 last:border-0"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-aurea-surface-2 text-[11px] font-semibold text-aurea-ink-2 ring-1 ring-aurea-border">
                        {initialsOf(org.name)}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-[14px] font-medium text-aurea-ink">{org.name}</p>
                        <p className="truncate font-mono text-[11px] text-aurea-ink-3">{org.slug}</p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="hidden font-mono text-[10px] uppercase tracking-wide text-aurea-ink-3 sm:inline">
                        {org.subscription_tier}
                      </span>
                      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium capitalize">
                        <span className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-aurea-primary' : 'bg-aurea-amber'}`} />
                        <span className={active ? 'text-aurea-primary' : 'text-aurea-amber'}>
                          {org.subscription_status}
                        </span>
                      </span>
                    </div>
                  </div>
                )
              })
            ) : (
              <p className="py-10 text-center text-[13px] text-aurea-ink-3">
                No practices yet. Add your first practice.
              </p>
            )}
          </div>
        </section>

        {/* AI Platform */}
        <section className="aurea-card overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-aurea-border px-5 py-4">
            <div>
              <h2 className="aurea-display text-[22px] text-aurea-ink">AI Platform</h2>
              <p className="mt-0.5 text-[12px] text-aurea-ink-3">Current configuration across all practices</p>
            </div>
            <Link
              href="/agency/ai-config"
              className="group inline-flex items-center gap-1.5 text-[12px] font-medium text-aurea-ink-2 transition-colors hover:text-aurea-ink"
            >
              Configure
              <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </div>
          <div className="px-5">
            {platformStatus.map((item) => (
              <div
                key={item.label}
                className="flex items-center justify-between gap-3 border-b border-aurea-border py-3.5 last:border-0"
              >
                <div className="flex items-center gap-2.5">
                  <span className={`h-1.5 w-1.5 rounded-full ${item.ok ? 'bg-aurea-primary' : 'bg-aurea-rose'}`} />
                  <span className="text-[13px] text-aurea-ink-2">{item.label}</span>
                </div>
                <span className="font-mono text-[12px] text-aurea-ink">{item.value}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* ── Quick actions ──────────────────────────────────── */}
      <section className="mt-10">
        <p className="aurea-eyebrow mb-3">Quick Actions</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {quickActions.map((action) => (
            <Link
              key={action.label}
              href={action.href}
              className="aurea-card group flex items-center gap-3.5 p-4 transition-colors hover:bg-aurea-surface-2"
            >
              <action.icon className="h-[18px] w-[18px] shrink-0 text-aurea-ink-2" strokeWidth={1.75} />
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-medium text-aurea-ink">{action.label}</p>
                <p className="truncate text-[11px] text-aurea-ink-3">{action.desc}</p>
              </div>
              <ArrowUpRight className="h-4 w-4 shrink-0 text-aurea-ink-3 transition-colors group-hover:text-aurea-primary" />
            </Link>
          ))}
        </div>
      </section>
    </div>
  )
}
