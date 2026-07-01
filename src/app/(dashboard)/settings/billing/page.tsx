'use client'

import { useState } from 'react'
import { useOrgStore } from '@/lib/store/use-org'
import { RoleGuard } from '@/components/auth/role-guard'
import { Button } from '@/components/ui/button'
import {
  CreditCard,
  TrendingUp,
  DollarSign,
  Receipt,
  ArrowUpRight,
  Calendar,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  Loader2,
} from 'lucide-react'
import { toast } from 'sonner'

export default function BillingPage() {
  return (
    <RoleGuard requiredPermission="billing:read">
      <BillingContent />
    </RoleGuard>
  )
}

function BillingContent() {
  const { organization } = useOrgStore()
  const [upgradeLoading, setUpgradeLoading] = useState<string | null>(null)
  const [portalLoading, setPortalLoading] = useState(false)

  // Subscription status semantics: active=emerald, trial=amber, past_due/other=rose
  function statusBadgeClasses(status: string) {
    if (status === 'active') return 'bg-aurea-primary/10 text-aurea-primary border-aurea-primary/20'
    if (status === 'trialing' || status === 'trial') return 'bg-aurea-amber/10 text-aurea-amber border-aurea-amber/20'
    return 'bg-aurea-rose/10 text-aurea-rose border-aurea-rose/20'
  }

  // Tier badge: trial=amber, starter/professional/enterprise=emerald
  function tierBadgeClasses(tier: string) {
    if (tier === 'trial') return 'bg-aurea-amber/10 text-aurea-amber border-aurea-amber/20'
    return 'bg-aurea-primary/10 text-aurea-primary border-aurea-primary/20'
  }

  const tierPrices: Record<string, string> = {
    trial: '$0',
    starter: '$299',
    professional: '$599',
    enterprise: 'Custom',
  }

  const tier = organization?.subscription_tier || 'trial'
  const status = organization?.subscription_status || 'active'
  const hasStripeCustomer = !!organization?.stripe_customer_id

  async function handleUpgrade(targetTier: string) {
    if (targetTier === 'enterprise') {
      window.open('mailto:sales@dionhealth.com?subject=Enterprise Plan Inquiry', '_blank')
      return
    }

    setUpgradeLoading(targetTier)
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: targetTier }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to create checkout session')
      }

      const { url } = await res.json()
      if (url) {
        window.location.href = url
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to start checkout')
    } finally {
      setUpgradeLoading(null)
    }
  }

  async function handleManageSubscription() {
    setPortalLoading(true)
    try {
      const res = await fetch('/api/billing/portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to open billing portal')
      }

      const { url } = await res.json()
      if (url) {
        window.location.href = url
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to open billing portal')
    } finally {
      setPortalLoading(false)
    }
  }

  return (
    <div className="animate-in fade-in-0 duration-500 space-y-8 max-w-4xl">
      {/* ── Header ────────────────────────────────────────── */}
      <header className="border-b border-aurea-border pb-8">
        <p className="aurea-eyebrow mb-3">Account</p>
        <h1 className="aurea-display text-[40px] text-aurea-ink sm:text-[48px]">
          Billing &amp; Subscription
        </h1>
        <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-aurea-ink-2">
          Manage your practice subscription, view invoices, and track usage.
        </p>
      </header>

      {/* ── Current plan card ─────────────────────────────── */}
      <section className="aurea-card overflow-hidden">
        <div className="border-b border-aurea-border px-6 py-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-center gap-3">
              <Sparkles className="h-[18px] w-[18px] text-aurea-ink-3" strokeWidth={1.75} />
              <div>
                <p className="aurea-eyebrow">Current Plan</p>
                <h2 className="aurea-display text-[22px] text-aurea-ink mt-0.5">
                  {organization?.name || 'Your Practice'}
                </h2>
              </div>
            </div>
            <div className="flex items-center gap-2.5">
              <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold capitalize ${tierBadgeClasses(tier)}`}>
                {tier}
              </span>
              <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${statusBadgeClasses(status)}`}>
                {status === 'active' ? (
                  <><CheckCircle2 className="h-3 w-3" /> Active</>
                ) : (
                  <><AlertCircle className="h-3 w-3" /> {status}</>
                )}
              </span>
            </div>
          </div>
        </div>

        <div className="px-6 py-5">
          <div className="flex items-baseline gap-1 mb-2">
            <span className="aurea-display text-[48px] tabular-nums text-aurea-ink">{tierPrices[tier]}</span>
            {tierPrices[tier] !== 'Custom' && (
              <span className="text-[14px] text-aurea-ink-3 mb-1">/mo</span>
            )}
          </div>

          {organization?.trial_ends_at && tier === 'trial' && (
            <p className="text-[13px] text-aurea-amber mb-5 flex items-center gap-1.5">
              <Calendar className="h-[15px] w-[15px]" strokeWidth={1.75} />
              Trial ends {new Date(organization.trial_ends_at).toLocaleDateString()}
            </p>
          )}

          <div className="flex gap-3 mt-5">
            {tier !== 'enterprise' && (
              <Button
                className="gap-2"
                onClick={() => handleUpgrade(tier === 'trial' ? 'starter' : tier === 'starter' ? 'professional' : 'enterprise')}
                disabled={!!upgradeLoading}
              >
                {upgradeLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowUpRight className="h-4 w-4" />
                )}
                Upgrade Plan
              </Button>
            )}
            <Button
              variant="outline"
              onClick={handleManageSubscription}
              disabled={!hasStripeCustomer || portalLoading}
            >
              {portalLoading ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              Manage Subscription
            </Button>
          </div>
        </div>
      </section>

      {/* ── Revenue KPI grid ──────────────────────────────── */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <RevenueCard
          index="01"
          label="Monthly Revenue"
          value="$0.00"
          sub="+0% vs last month"
          icon={DollarSign}
        />
        <RevenueCard
          index="02"
          label="Total Collected"
          value="$0.00"
          sub="+0% all time"
          icon={TrendingUp}
        />
        <RevenueCard
          index="03"
          label="Pending Claims"
          value="$0.00"
          sub="0 active"
          icon={Receipt}
        />
        <RevenueCard
          index="04"
          label="Payment Methods"
          value={hasStripeCustomer ? '1' : '0'}
          sub={hasStripeCustomer ? 'On file' : 'None added'}
          icon={CreditCard}
        />
      </div>

      {/* ── Invoice history ───────────────────────────────── */}
      <section className="aurea-card overflow-hidden">
        <div className="border-b border-aurea-border px-6 py-4">
          <h2 className="aurea-display text-[22px] text-aurea-ink">Invoice History</h2>
          <p className="mt-0.5 text-[12px] text-aurea-ink-3">View and download past invoices</p>
        </div>
        <div className="px-6 py-10 flex flex-col items-center justify-center text-center">
          {hasStripeCustomer ? (
            <>
              <p className="text-[13px] text-aurea-ink-2 mb-4">
                View your full invoice history in the Stripe portal.
              </p>
              <Button variant="outline" onClick={handleManageSubscription} disabled={portalLoading}>
                {portalLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                View Invoices
              </Button>
            </>
          ) : (
            <>
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-aurea-surface-2 mb-4">
                <Receipt className="h-[18px] w-[18px] text-aurea-ink-3" strokeWidth={1.75} />
              </div>
              <p className="text-[14px] font-medium text-aurea-ink">No invoices yet</p>
              <p className="text-[12px] text-aurea-ink-3 mt-1 max-w-sm">
                Invoices will appear here once you upgrade from the trial plan and make your first payment.
              </p>
            </>
          )}
        </div>
      </section>

      {/* ── Plan comparison ───────────────────────────────── */}
      <section>
        <p className="aurea-eyebrow mb-3">Plans</p>
        <h2 className="aurea-display text-[28px] text-aurea-ink mb-1">Choose your plan</h2>
        <p className="text-[13px] text-aurea-ink-3 mb-6">Find the tier that fits your practice.</p>
        <div className="grid gap-4 grid-cols-1 md:grid-cols-3">
          <PlanCard
            name="Starter"
            price="$299"
            features={['Up to 5 team members', 'Basic AI automation', '500 leads/month', 'Email campaigns', 'Standard support']}
            current={tier === 'starter'}
            onUpgrade={() => handleUpgrade('starter')}
            loading={upgradeLoading === 'starter'}
            canUpgrade={tier === 'trial'}
          />
          <PlanCard
            name="Professional"
            price="$599"
            features={['Up to 15 team members', 'Advanced AI with autopilot', 'Unlimited leads', 'Multi-channel campaigns', 'Priority support', 'Analytics dashboard']}
            current={tier === 'professional'}
            highlighted
            onUpgrade={() => handleUpgrade('professional')}
            loading={upgradeLoading === 'professional'}
            canUpgrade={tier === 'trial' || tier === 'starter'}
          />
          <PlanCard
            name="Enterprise"
            price="Custom"
            features={['Unlimited team members', 'Custom AI training', 'Dedicated account manager', 'API access', 'HIPAA BAA', 'Custom integrations']}
            current={tier === 'enterprise'}
            onUpgrade={() => handleUpgrade('enterprise')}
            loading={upgradeLoading === 'enterprise'}
            canUpgrade={tier !== 'enterprise'}
          />
        </div>
      </section>
    </div>
  )
}

// ── Revenue Card ──────────────────────────────────────────────────

function RevenueCard({
  index,
  label,
  value,
  sub,
  icon: Icon,
}: {
  index: string
  label: string
  value: string
  sub: string
  icon: React.ElementType
}) {
  return (
    <div className="aurea-card p-5">
      <div className="flex items-center justify-between">
        <p className="aurea-eyebrow">{label}</p>
        <span className="font-mono text-[11px] tabular-nums text-aurea-ink-3">/{index}</span>
      </div>
      <div className="mt-4 flex items-end justify-between">
        <p className="aurea-display text-[32px] tabular-nums text-aurea-ink">{value}</p>
        <Icon className="mb-1.5 h-[18px] w-[18px] text-aurea-ink-3" strokeWidth={1.75} />
      </div>
      <p className="mt-3 text-[11.5px] text-aurea-ink-3">{sub}</p>
    </div>
  )
}

// ── Plan Card ─────────────────────────────────────────────────────

function PlanCard({
  name,
  price,
  features,
  current,
  highlighted,
  onUpgrade,
  loading,
  canUpgrade,
}: {
  name: string
  price: string
  features: string[]
  current: boolean
  highlighted?: boolean
  onUpgrade: () => void
  loading: boolean
  canUpgrade: boolean
}) {
  return (
    <div
      className={[
        'relative rounded-xl border p-5 transition-colors',
        highlighted
          ? 'border-aurea-primary/30 bg-aurea-primary/5'
          : 'border-aurea-border bg-aurea-surface',
        current ? 'ring-2 ring-aurea-primary' : '',
      ].join(' ')}
    >
      {highlighted && (
        <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 inline-flex items-center rounded-full bg-aurea-primary px-2.5 py-0.5 text-[10px] font-semibold text-white">
          Most Popular
        </span>
      )}
      <p className="aurea-eyebrow mb-2">{name}</p>
      <div className="flex items-baseline gap-0.5 mb-5">
        <span className="aurea-display text-[36px] tabular-nums text-aurea-ink">{price}</span>
        {price !== 'Custom' && (
          <span className="text-[13px] text-aurea-ink-3 mb-1">/mo</span>
        )}
      </div>
      <ul className="space-y-2.5 mb-6">
        {features.map((f) => (
          <li key={f} className="flex items-center gap-2 text-[13px] text-aurea-ink-2">
            <CheckCircle2 className="h-3.5 w-3.5 text-aurea-primary shrink-0" strokeWidth={2} />
            {f}
          </li>
        ))}
      </ul>
      <Button
        variant={current ? 'secondary' : highlighted ? 'default' : 'outline'}
        className="w-full"
        disabled={current || !canUpgrade || loading}
        onClick={onUpgrade}
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin mr-2" />
        ) : null}
        {current ? 'Current Plan' : name === 'Enterprise' ? 'Contact Sales' : 'Upgrade'}
      </Button>
    </div>
  )
}
