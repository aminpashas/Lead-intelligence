'use client'

import { useOrgStore } from '@/lib/store/use-org'
import { RoleGuard } from '@/components/auth/role-guard'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
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
} from 'lucide-react'
import { cn } from '@/lib/utils'

export default function BillingPage() {
  return (
    <RoleGuard requiredPermission="billing:read">
      <BillingContent />
    </RoleGuard>
  )
}

function BillingContent() {
  const { organization } = useOrgStore()

  const tierColors: Record<string, string> = {
    trial: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/25',
    starter: 'bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/25',
    professional: 'bg-violet-500/15 text-violet-700 dark:text-violet-400 border-violet-500/25',
    enterprise: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/25',
  }

  const tierPrices: Record<string, string> = {
    trial: '$0/mo',
    starter: '$299/mo',
    professional: '$599/mo',
    enterprise: 'Custom',
  }

  const tier = organization?.subscription_tier || 'trial'
  const status = organization?.subscription_status || 'active'

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Billing & Subscription</h1>
        <p className="text-muted-foreground">
          Manage your practice subscription, view invoices, and track revenue
        </p>
      </div>

      {/* Subscription Card */}
      <Card className="overflow-hidden">
        <div className="relative">
          <div className="absolute inset-0 bg-gradient-to-r from-violet-500/5 via-purple-500/5 to-pink-500/5" />
          <CardHeader className="relative">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Sparkles className="h-5 w-5 text-violet-500" />
                  Current Plan
                </CardTitle>
                <CardDescription className="mt-1">
                  {organization?.name || 'Your Practice'}
                </CardDescription>
              </div>
              <div className="flex items-center gap-3">
                <Badge
                  variant="outline"
                  className={cn('text-sm px-3 py-1 font-semibold capitalize', tierColors[tier])}
                >
                  {tier}
                </Badge>
                <Badge
                  variant="outline"
                  className={cn(
                    'text-xs',
                    status === 'active'
                      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/25'
                      : 'bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/25'
                  )}
                >
                  {status === 'active' ? (
                    <><CheckCircle2 className="h-3 w-3 mr-1" /> Active</>
                  ) : (
                    <><AlertCircle className="h-3 w-3 mr-1" /> {status}</>
                  )}
                </Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="relative">
            <div className="flex items-baseline gap-1 mb-4">
              <span className="text-4xl font-bold tracking-tight">{tierPrices[tier]}</span>
            </div>

            {organization?.trial_ends_at && tier === 'trial' && (
              <p className="text-sm text-muted-foreground mb-4 flex items-center gap-1.5">
                <Calendar className="h-4 w-4" />
                Trial ends {new Date(organization.trial_ends_at).toLocaleDateString()}
              </p>
            )}

            <div className="flex gap-3">
              <Button className="gap-2">
                <ArrowUpRight className="h-4 w-4" />
                Upgrade Plan
              </Button>
              <Button variant="outline">Manage Subscription</Button>
            </div>
          </CardContent>
        </div>
      </Card>

      {/* Revenue Stats */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <RevenueCard
          label="Monthly Revenue"
          value="$0.00"
          change="+0%"
          icon={DollarSign}
          gradient="from-emerald-500/10 to-teal-500/10"
          iconColor="text-emerald-600 dark:text-emerald-400"
        />
        <RevenueCard
          label="Total Collected"
          value="$0.00"
          change="+0%"
          icon={TrendingUp}
          gradient="from-blue-500/10 to-cyan-500/10"
          iconColor="text-blue-600 dark:text-blue-400"
        />
        <RevenueCard
          label="Pending Claims"
          value="$0.00"
          change="0 active"
          icon={Receipt}
          gradient="from-amber-500/10 to-orange-500/10"
          iconColor="text-amber-600 dark:text-amber-400"
        />
        <RevenueCard
          label="Payment Methods"
          value="0"
          change="None added"
          icon={CreditCard}
          gradient="from-violet-500/10 to-purple-500/10"
          iconColor="text-violet-600 dark:text-violet-400"
        />
      </div>

      {/* Invoices */}
      <Card>
        <CardHeader>
          <CardTitle>Invoice History</CardTitle>
          <CardDescription>
            View and download past invoices
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted mb-4">
              <Receipt className="h-7 w-7 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">No invoices yet</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-sm">
              Invoices will appear here once you upgrade from the trial plan and make your first payment.
            </p>
          </div>
        </CardContent>
      </Card>

      <Separator />

      {/* Plan Comparison */}
      <Card>
        <CardHeader>
          <CardTitle>Plan Comparison</CardTitle>
          <CardDescription>Choose the plan that best fits your practice</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 grid-cols-1 md:grid-cols-3">
            <PlanCard
              name="Starter"
              price="$299"
              features={['Up to 5 team members', 'Basic AI automation', '500 leads/month', 'Email campaigns', 'Standard support']}
              current={tier === 'starter'}
            />
            <PlanCard
              name="Professional"
              price="$599"
              features={['Up to 15 team members', 'Advanced AI with autopilot', 'Unlimited leads', 'Multi-channel campaigns', 'Priority support', 'Analytics dashboard']}
              current={tier === 'professional'}
              highlighted
            />
            <PlanCard
              name="Enterprise"
              price="Custom"
              features={['Unlimited team members', 'Custom AI training', 'Dedicated account manager', 'API access', 'HIPAA BAA', 'Custom integrations']}
              current={tier === 'enterprise'}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// ── Revenue Card ────────────────────────────────────────────────

function RevenueCard({
  label,
  value,
  change,
  icon: Icon,
  gradient,
  iconColor,
}: {
  label: string
  value: string
  change: string
  icon: React.ElementType
  gradient: string
  iconColor: string
}) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold mt-1">{value}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{change}</p>
          </div>
          <div className={cn('flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br', gradient)}>
            <Icon className={cn('h-5 w-5', iconColor)} />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Plan Card ───────────────────────────────────────────────────

function PlanCard({
  name,
  price,
  features,
  current,
  highlighted,
}: {
  name: string
  price: string
  features: string[]
  current: boolean
  highlighted?: boolean
}) {
  return (
    <div
      className={cn(
        'rounded-lg border p-5 relative',
        highlighted && 'border-violet-500/50 bg-violet-500/5',
        current && 'ring-2 ring-primary'
      )}
    >
      {highlighted && (
        <Badge className="absolute -top-2.5 left-1/2 -translate-x-1/2 bg-violet-600 text-white text-[10px]">
          Most Popular
        </Badge>
      )}
      <h3 className="font-semibold text-lg">{name}</h3>
      <div className="flex items-baseline gap-0.5 mt-2 mb-4">
        <span className="text-3xl font-bold">{price}</span>
        {price !== 'Custom' && <span className="text-sm text-muted-foreground">/mo</span>}
      </div>
      <ul className="space-y-2 mb-5">
        {features.map((f) => (
          <li key={f} className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
            {f}
          </li>
        ))}
      </ul>
      <Button
        variant={current ? 'secondary' : highlighted ? 'default' : 'outline'}
        className="w-full"
        disabled={current}
      >
        {current ? 'Current Plan' : 'Upgrade'}
      </Button>
    </div>
  )
}
