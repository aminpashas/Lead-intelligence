import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { hasPermission } from '@/lib/auth/permissions'
import { formatUsd } from '@/lib/billing/spend-summary'
import { loadLiveSpend, type OrgUsage } from '@/lib/billing/usage-live'
import { Bot, MessageSquare, Phone, Mail } from 'lucide-react'

export const metadata = {
  title: 'Usage & Costs | Lead Intelligence',
}

const RANGES = [7, 30, 90]

type Row = {
  key: 'ai' | 'sms' | 'voice' | 'email'
  label: string
  icon: typeof Bot
  volume: string
  billableCents: number
}

function buildRows(u: OrgUsage | undefined): Row[] {
  const q = u?.quantities
  const s = u?.services
  return [
    {
      key: 'ai',
      label: 'AI & Automation',
      icon: Bot,
      volume: q ? `${q.aiCalls.toLocaleString()} AI actions · ${(q.aiTokensIn + q.aiTokensOut).toLocaleString()} tokens` : '—',
      billableCents: s?.ai.billableCents ?? 0,
    },
    {
      key: 'sms',
      label: 'Text messaging (SMS)',
      icon: MessageSquare,
      volume: q ? `${q.smsOutCount.toLocaleString()} sent · ${q.smsOutSegments.toLocaleString()} segments · ${q.smsInCount.toLocaleString()} received` : '—',
      billableCents: s?.sms.billableCents ?? 0,
    },
    {
      key: 'voice',
      label: 'Phone (voice)',
      icon: Phone,
      volume: q ? `${q.voiceCalls.toLocaleString()} calls · ${Math.round(q.voiceSeconds / 60).toLocaleString()} minutes` : '—',
      billableCents: s?.voice.billableCents ?? 0,
    },
    {
      key: 'email',
      label: 'Email',
      icon: Mail,
      volume: q ? `${q.emailOutCount.toLocaleString()} sent` : '—',
      billableCents: s?.email.billableCents ?? 0,
    },
  ]
}

export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>
}) {
  const { days } = await searchParams
  const sinceDays = RANGES.includes(Number(days)) ? Number(days) : 30

  const supabase = await createClient()
  const active = await resolveActiveOrg(supabase)
  if (!active.orgId || !active.role) redirect('/login')

  if (!hasPermission(active.role, 'billing:read')) {
    return (
      <div className="max-w-2xl">
        <p className="aurea-eyebrow mb-3">Account</p>
        <h1 className="aurea-display text-[32px] text-aurea-ink">Usage &amp; Costs</h1>
        <p className="mt-4 text-[14px] text-aurea-ink-2">
          You don&rsquo;t have access to billing &amp; usage. Ask a practice admin for access.
        </p>
      </div>
    )
  }

  const [{ byOrg }, invoicesRes] = await Promise.all([
    loadLiveSpend(supabase, { sinceDays, organizationId: active.orgId }),
    supabase
      .from('usage_invoices')
      .select('id, period_start, period_end, total_cents, status')
      .eq('organization_id', active.orgId)
      .eq('status', 'issued')
      .order('period_start', { ascending: false })
      .limit(12),
  ])
  const usage = byOrg[active.orgId]
  const invoices = (invoicesRes.data ?? []) as { id: string; period_start: string; period_end: string; total_cents: number; status: string }[]

  const monthLabel = (d: string) =>
    new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
  const rows = buildRows(usage)
  const totalBillable = rows.reduce((sum, r) => sum + r.billableCents, 0)
  const maxRow = Math.max(1, ...rows.map((r) => r.billableCents))
  const hasUsage = totalBillable > 0

  return (
    <div className="animate-in fade-in-0 duration-500 space-y-8 max-w-4xl">
      {/* ── Header ────────────────────────────────────────── */}
      <header className="flex flex-col gap-5 border-b border-aurea-border pb-8 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="aurea-eyebrow mb-3">Account</p>
          <h1 className="aurea-display text-[40px] text-aurea-ink sm:text-[48px]">Usage &amp; Costs</h1>
          <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-aurea-ink-2">
            What your AI, text messaging, and phone activity costs — all figures include your plan&rsquo;s
            service rate. This is separate from your monthly subscription.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1 rounded-full border border-aurea-border p-1">
          {RANGES.map((r) => (
            <Link
              key={r}
              href={`/settings/usage?days=${r}`}
              className={`rounded-full px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] transition-colors ${
                r === sinceDays ? 'bg-aurea-ink text-aurea-surface' : 'text-aurea-ink-3 hover:text-aurea-ink'
              }`}
            >
              {r}d
            </Link>
          ))}
        </div>
      </header>

      {/* ── Total ─────────────────────────────────────────── */}
      <section className="aurea-card p-6">
        <div className="flex items-center justify-between">
          <p className="aurea-eyebrow">Usage this period · last {sinceDays} days</p>
          <span className="font-mono text-[11px] tabular-nums text-aurea-ink-3">/01</span>
        </div>
        <p className="mt-4 aurea-display text-[52px] tabular-nums text-aurea-ink">{formatUsd(totalBillable)}</p>
        <p className="mt-2 text-[12.5px] text-aurea-ink-3">Rate included · billed on top of your subscription</p>
      </section>

      {/* ── Breakdown ─────────────────────────────────────── */}
      <section className="aurea-card overflow-hidden">
        <div className="border-b border-aurea-border px-6 py-4">
          <h2 className="aurea-display text-[22px] text-aurea-ink">Breakdown</h2>
          <p className="mt-0.5 text-[12px] text-aurea-ink-3">Your activity by channel</p>
        </div>
        <div className="px-6 py-1">
          {hasUsage ? (
            rows.map((r) => {
              const width = Math.round((r.billableCents / maxRow) * 100)
              return (
                <div key={r.key} className="border-b border-aurea-border py-4 last:border-0">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <r.icon className="h-[17px] w-[17px] shrink-0 text-aurea-ink-3" strokeWidth={1.75} />
                      <div className="min-w-0">
                        <p className="text-[14px] font-medium text-aurea-ink">{r.label}</p>
                        <p className="mt-0.5 truncate font-mono text-[11px] text-aurea-ink-3">{r.volume}</p>
                      </div>
                    </div>
                    <span className="shrink-0 font-mono text-[15px] tabular-nums text-aurea-ink">{formatUsd(r.billableCents)}</span>
                  </div>
                  <div className="mt-2.5 h-[3px] w-full overflow-hidden rounded-full bg-aurea-surface-2">
                    <div className="h-full rounded-full bg-aurea-primary" style={{ width: `${width}%` }} />
                  </div>
                </div>
              )
            })
          ) : (
            <p className="py-12 text-center text-[13px] text-aurea-ink-3">
              No AI, SMS, or phone usage in the last {sinceDays} days.
            </p>
          )}
        </div>
      </section>

      {/* ── Invoices ──────────────────────────────────────── */}
      {invoices.length > 0 && (
        <section className="aurea-card overflow-hidden">
          <div className="border-b border-aurea-border px-6 py-4">
            <h2 className="aurea-display text-[22px] text-aurea-ink">Invoices</h2>
            <p className="mt-0.5 text-[12px] text-aurea-ink-3">Issued monthly bills (usage + platform fee)</p>
          </div>
          <div className="px-6 py-1">
            {invoices.map((inv) => (
              <div key={inv.id} className="flex items-center justify-between border-b border-aurea-border py-3.5 last:border-0">
                <p className="text-[13.5px] font-medium text-aurea-ink">{monthLabel(inv.period_start)}</p>
                <span className="font-mono text-[14px] tabular-nums text-aurea-ink">{formatUsd(inv.total_cents)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <p className="max-w-2xl text-[11.5px] leading-relaxed text-aurea-ink-3">
        Usage is measured from your account activity: AI actions (lead scoring, drafting, summaries),
        text-message segments sent &amp; received, and phone-call minutes. Amounts are estimates for
        transparency; your invoice of record is issued separately.
      </p>
    </div>
  )
}
