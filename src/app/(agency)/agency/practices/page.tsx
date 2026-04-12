import { createClient } from '@/lib/supabase/server'
import { Building2, CheckCircle2, AlertCircle, Clock } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

export const metadata = {
  title: 'Practices | Agency | Lead Intelligence',
}

const TIER_COLORS: Record<string, string> = {
  trial: 'bg-slate-700 text-slate-300',
  starter: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  professional: 'bg-violet-500/20 text-violet-300 border-violet-500/30',
  enterprise: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
}

const STATUS_ICONS: Record<string, React.ReactNode> = {
  active: <CheckCircle2 className="h-4 w-4 text-emerald-400" />,
  past_due: <AlertCircle className="h-4 w-4 text-red-400" />,
  canceled: <AlertCircle className="h-4 w-4 text-slate-500" />,
  trialing: <Clock className="h-4 w-4 text-amber-400" />,
}

export default async function PracticesPage() {
  const supabase = await createClient()

  const { data: organizations } = await supabase
    .from('organizations')
    .select('*')
    .order('created_at', { ascending: false })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Practices</h1>
        <p className="text-slate-400 text-sm mt-1">
          All dental practices using the platform. {organizations?.length ?? 0} total.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {organizations?.map((org) => (
          <Card
            key={org.id}
            className="bg-slate-900 border-slate-800 hover:border-slate-700 transition-all duration-200 group"
          >
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-slate-700 to-slate-800 flex items-center justify-center border border-slate-700 group-hover:border-violet-500/30 transition-colors">
                    <Building2 className="h-5 w-5 text-slate-300" />
                  </div>
                  <div>
                    <CardTitle className="text-white text-sm">{org.name}</CardTitle>
                    <CardDescription className="text-slate-500 text-xs mt-0.5">
                      /{org.slug}
                    </CardDescription>
                  </div>
                </div>
                {STATUS_ICONS[org.subscription_status] ?? STATUS_ICONS['active']}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">Plan</span>
                <Badge
                  className={`capitalize text-[10px] h-4 px-1.5 border ${TIER_COLORS[org.subscription_tier] ?? TIER_COLORS['trial']}`}
                >
                  {org.subscription_tier}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">Status</span>
                <span className="text-xs text-slate-300 capitalize">
                  {org.subscription_status.replace('_', ' ')}
                </span>
              </div>
              {org.email && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-500">Email</span>
                  <span className="text-xs text-slate-300 truncate max-w-[160px]">{org.email}</span>
                </div>
              )}
              {org.phone && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-500">Phone</span>
                  <span className="text-xs text-slate-300">{org.phone}</span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">Created</span>
                <span className="text-xs text-slate-300">
                  {new Date(org.created_at).toLocaleDateString()}
                </span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {(!organizations || organizations.length === 0) && (
        <div className="rounded-xl border border-dashed border-slate-700 p-12 text-center">
          <Building2 className="h-10 w-10 text-slate-600 mx-auto mb-3" />
          <h3 className="text-sm font-medium text-slate-400">No practices yet</h3>
          <p className="text-xs text-slate-500 mt-1">
            Practices will appear here once they&apos;re added to the platform.
          </p>
        </div>
      )}
    </div>
  )
}
