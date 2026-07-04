import { createClient } from '@/lib/supabase/server'
import { loadLiveSpend } from '@/lib/billing/usage-live'
import { resolveMarkupPct, resolvePlatformFeeCents, DEFAULT_MARKUP_PCT, DEFAULT_PLATFORM_FEE_CENTS } from '@/lib/billing/markup'
import { PricingCalculator, type PricingPractice } from '@/components/agency/pricing-calculator'

export const metadata = {
  title: 'Pricing Calculator | Lead Intelligence',
}

export default async function AgencyPricingPage() {
  const supabase = await createClient()

  // Usage cost per practice over the trailing 30 days (≈ a monthly run-rate) drives the live preview.
  const { byOrg } = await loadLiveSpend(supabase, { sinceDays: 30 })

  const [{ data: orgs }, { data: settings }] = await Promise.all([
    supabase.from('organizations').select('id, name').order('name'),
    supabase
      .from('billing_settings')
      .select('organization_id, markups, platform_fee_cents, autocharge, stripe_customer_id, billing_mode, auto_reload, reload_amount_cents, balance_cents'),
  ])

  const settingsByOrg = new Map<
    string,
    {
      markups: Record<string, number> | null
      platform_fee_cents: number | null
      autocharge: boolean
      stripe_customer_id: string | null
      billing_mode: 'invoice' | 'prepaid'
      auto_reload: boolean
      reload_amount_cents: number | null
      balance_cents: number
    }
  >()
  for (const s of settings ?? []) {
    settingsByOrg.set(s.organization_id as string, {
      markups: s.markups as Record<string, number> | null,
      platform_fee_cents: s.platform_fee_cents as number | null,
      autocharge: (s.autocharge as boolean | null) ?? false,
      stripe_customer_id: (s.stripe_customer_id as string | null) ?? null,
      billing_mode: ((s.billing_mode as string | null) as 'invoice' | 'prepaid') ?? 'invoice',
      auto_reload: (s.auto_reload as boolean | null) ?? false,
      reload_amount_cents: (s.reload_amount_cents as number | null) ?? null,
      balance_cents: Number(s.balance_cents ?? 0),
    })
  }

  const practices: PricingPractice[] = (orgs ?? [])
    .map((o) => {
      const cfg = settingsByOrg.get(o.id as string)
      const usageCostCents = Math.round(byOrg[o.id as string]?.costCents ?? 0)
      return {
        id: o.id as string,
        name: (o.name as string) ?? 'Unnamed practice',
        usageCostCents,
        currentMarkupPct: resolveMarkupPct('sms', cfg ? { markups: cfg.markups } : null),
        currentFeeCents: resolvePlatformFeeCents(cfg?.platform_fee_cents),
        hasOverride: !!cfg,
        autocharge: cfg?.autocharge ?? false,
        hasCardOnFile: !!cfg?.stripe_customer_id,
        prepaid: cfg?.billing_mode === 'prepaid',
        autoReload: cfg?.auto_reload ?? false,
        reloadAmountCents: cfg?.reload_amount_cents ?? 50_000,
        balanceCents: cfg?.balance_cents ?? 0,
      }
    })
    // Practices with usage first (they matter most), then alphabetical.
    .sort((a, b) => b.usageCostCents - a.usageCostCents || a.name.localeCompare(b.name))

  return (
    <div className="animate-in fade-in-0 duration-500">
      <header className="border-b border-aurea-border pb-8">
        <p className="aurea-eyebrow mb-3">Cost Intelligence</p>
        <h1 className="aurea-display text-[40px] text-aurea-ink sm:text-[52px]">Pricing Calculator</h1>
        <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-aurea-ink-2">
          Set each practice&rsquo;s re-bill markup and monthly platform fee, and see the blended monthly
          bill update live against their real usage. House default is{' '}
          <span className="font-medium text-aurea-ink">
            {(1 + DEFAULT_MARKUP_PCT.sms / 100).toFixed(1)}× cost
          </span>{' '}
          + {(DEFAULT_PLATFORM_FEE_CENTS / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}/mo.
        </p>
      </header>

      <PricingCalculator practices={practices} />
    </div>
  )
}
