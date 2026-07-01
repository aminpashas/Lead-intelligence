import { createClient } from '@/lib/supabase/server'
import { Building2, CheckCircle2, AlertCircle, Clock } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { EnterAccountButton } from './enter-account-button'
import { AddPracticeButton } from './add-practice-button'

export const metadata = {
  title: 'Practices | Agency | Lead Intelligence',
}

const TIER_COLORS: Record<string, string> = {
  trial: 'bg-aurea-surface-2 text-aurea-ink-3',
  starter: 'bg-aurea-primary/10 text-aurea-primary border-aurea-primary/20',
  professional: 'bg-aurea-gold/10 text-aurea-gold border-aurea-gold/20',
  enterprise: 'bg-aurea-amber/10 text-aurea-amber border-aurea-amber/20',
}

const STATUS_ICONS: Record<string, React.ReactNode> = {
  active: <CheckCircle2 className="h-4 w-4 text-aurea-primary" />,
  past_due: <AlertCircle className="h-4 w-4 text-aurea-rose" />,
  canceled: <AlertCircle className="h-4 w-4 text-aurea-ink-3" />,
  trialing: <Clock className="h-4 w-4 text-aurea-amber" />,
}

export default async function PracticesPage() {
  const supabase = await createClient()

  // The agency admin's own home org is the agency itself, not a client —
  // exclude it so the picker only lists real practices to enter.
  const { data: { user } } = await supabase.auth.getUser()
  const { data: me } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .eq('id', user?.id ?? '')
    .single()
  const agencyOrgId = me?.organization_id ?? null

  const { data: allOrgs } = await supabase
    .from('organizations')
    .select('*')
    .order('created_at', { ascending: false })

  const organizations = (allOrgs ?? []).filter((o) => o.id !== agencyOrgId)

  // Which client (if any) is the agency admin currently inside?
  const { data: active } = await supabase
    .from('agency_active_org')
    .select('active_org_id')
    .maybeSingle()
  const activeOrgId = active?.active_org_id ?? null

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-aurea-ink">Practices</h1>
          <p className="text-aurea-ink-2 text-sm mt-1">
            Client practices you manage. {organizations.length} total.
          </p>
        </div>
        <AddPracticeButton />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {organizations?.map((org) => (
          <Card
            key={org.id}
            className="bg-aurea-surface border-aurea-border hover:border-aurea-border-strong transition-all duration-200 group"
          >
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-xl bg-aurea-surface-2 flex items-center justify-center border border-aurea-border group-hover:border-aurea-primary/30 transition-colors">
                    <Building2 className="h-5 w-5 text-aurea-ink-3" />
                  </div>
                  <div>
                    <CardTitle className="text-aurea-ink text-sm">{org.name}</CardTitle>
                    <CardDescription className="text-aurea-ink-3 text-xs mt-0.5">
                      /{org.slug}
                    </CardDescription>
                  </div>
                </div>
                {STATUS_ICONS[org.subscription_status] ?? STATUS_ICONS['active']}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-aurea-ink-3">Plan</span>
                <Badge
                  className={`capitalize text-[10px] h-4 px-1.5 border ${TIER_COLORS[org.subscription_tier] ?? TIER_COLORS['trial']}`}
                >
                  {org.subscription_tier}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-aurea-ink-3">Status</span>
                <span className="text-xs text-aurea-ink-2 capitalize">
                  {org.subscription_status.replace('_', ' ')}
                </span>
              </div>
              {org.email && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-aurea-ink-3">Email</span>
                  <span className="text-xs text-aurea-ink-2 truncate max-w-[160px]">{org.email}</span>
                </div>
              )}
              {org.phone && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-aurea-ink-3">Phone</span>
                  <span className="text-xs text-aurea-ink-2">{org.phone}</span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-xs text-aurea-ink-3">Created</span>
                <span className="text-xs text-aurea-ink-2">
                  {new Date(org.created_at).toLocaleDateString()}
                </span>
              </div>
              <EnterAccountButton
                orgId={org.id}
                orgName={org.name}
                isCurrent={org.id === activeOrgId}
              />
            </CardContent>
          </Card>
        ))}
      </div>

      {(!organizations || organizations.length === 0) && (
        <div className="rounded-xl border border-dashed border-aurea-border p-12 text-center">
          <Building2 className="h-10 w-10 text-aurea-ink-3 mx-auto mb-3" />
          <h3 className="text-sm font-medium text-aurea-ink-2">No practices yet</h3>
          <p className="text-xs text-aurea-ink-3 mt-1">
            Practices will appear here once they&apos;re added to the platform.
          </p>
        </div>
      )}
    </div>
  )
}
