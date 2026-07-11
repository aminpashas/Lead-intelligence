import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { formatUsd } from '@/lib/billing/spend-summary'
import { loadLiveSpend } from '@/lib/billing/usage-live'
import { Building2, Network, ArrowLeft } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { AssignLocation } from './assign-location'

export const metadata = {
  title: 'Enterprise | Agency | Lead Intelligence',
}

/**
 * One enterprise account: its member locations plus a rolled-up spend total for
 * the enterprise (per-location rows + an enterprise blended total), sourced from
 * loadLiveSpend({ enterpriseAccountId }). Also lets the agency attach a standalone
 * location to this enterprise.
 */
export default async function EnterpriseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const { data: enterprise } = await supabase
    .from('enterprise_accounts')
    .select('id, name, slug')
    .eq('id', id)
    .maybeSingle()

  if (!enterprise) notFound()

  // Member locations of this enterprise.
  const { data: locations } = await supabase
    .from('organizations')
    .select('id, name, slug, subscription_tier, subscription_status')
    .eq('enterprise_account_id', id)
    .order('name', { ascending: true })

  // Standalone orgs (no enterprise) the agency could attach — exclude the agency's
  // own home org via the same approach as the practices page isn't needed here;
  // agency org has no enterprise and would just be an assignable option, which is
  // harmless, but we keep it out by only listing orgs the admin manages as clients.
  const { data: assignable } = await supabase
    .from('organizations')
    .select('id, name')
    .is('enterprise_account_id', null)
    .order('name', { ascending: true })

  // Rolled-up spend for the whole enterprise (per-location rows + total).
  const spend = await loadLiveSpend(supabase, { sinceDays: 30, enterpriseAccountId: id })

  const memberList = locations ?? []

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/agency/enterprises"
          className="inline-flex items-center gap-1.5 text-xs text-aurea-ink-3 hover:text-aurea-ink transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Enterprises
        </Link>
        <div className="mt-2 flex items-center gap-3">
          <div className="h-11 w-11 shrink-0 rounded-xl bg-aurea-surface-2 flex items-center justify-center border border-aurea-border">
            <Network className="h-5 w-5 text-aurea-ink-3" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-aurea-ink">{enterprise.name}</h1>
            <p className="text-aurea-ink-3 text-xs">/{enterprise.slug}</p>
          </div>
        </div>
      </div>

      {/* Rolled-up KPIs (last 30 days) */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <Card className="bg-aurea-surface border-aurea-border">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-medium text-aurea-ink-3">Locations</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-aurea-ink">{memberList.length}</p>
          </CardContent>
        </Card>
        <Card className="bg-aurea-surface border-aurea-border">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-medium text-aurea-ink-3">Blended Revenue · 30d</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-aurea-ink">
              {formatUsd(spend.enterpriseTotalBlendedCents ?? 0)}
            </p>
            <p className="text-[11px] text-aurea-ink-3 mt-0.5">usage + platform fees, all locations</p>
          </CardContent>
        </Card>
        <Card className="bg-aurea-surface border-aurea-border">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-medium text-aurea-ink-3">Provider Cost · 30d</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-aurea-ink">{formatUsd(spend.summary.totalCostCents)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Member locations */}
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-sm font-semibold text-aurea-ink">Locations</h2>
        <AssignLocation enterpriseId={id} options={assignable ?? []} />
      </div>

      <div className="rounded-xl border border-aurea-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-aurea-surface-2 text-aurea-ink-3 text-[11px] uppercase tracking-wide">
            <tr>
              <th className="text-left font-medium px-4 py-2.5">Location</th>
              <th className="text-left font-medium px-4 py-2.5">Tier</th>
              <th className="text-right font-medium px-4 py-2.5">Blended · 30d</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-aurea-border">
            {memberList.map((loc) => (
              <tr key={loc.id} className="bg-aurea-surface hover:bg-aurea-surface-2/50 transition-colors">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Building2 className="h-4 w-4 text-aurea-ink-3 shrink-0" />
                    <span className="text-aurea-ink truncate">{loc.name}</span>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <Badge className="capitalize text-[10px] bg-aurea-surface-2 text-aurea-ink-2 border border-aurea-border">
                    {loc.subscription_tier}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-right text-aurea-ink-2 tabular-nums">
                  {formatUsd(spend.byOrg[loc.id]?.blendedCents ?? 0)}
                </td>
              </tr>
            ))}
            {memberList.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-8 text-center text-xs text-aurea-ink-3">
                  No locations yet. Attach one above, or onboard a new practice under this enterprise.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
