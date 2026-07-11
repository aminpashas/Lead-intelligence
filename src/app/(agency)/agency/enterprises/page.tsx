import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { Network, Building2, ChevronRight } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { AddEnterpriseButton } from './add-enterprise-button'

export const metadata = {
  title: 'Enterprises | Agency | Lead Intelligence',
}

/**
 * Enterprise accounts (DSO umbrellas). Each enterprise groups N locations
 * (organizations); each location still bills and prices independently. This list
 * is the entry point — a detail page rolls spend up across an enterprise.
 */
export default async function EnterprisesPage() {
  const supabase = await createClient()

  const { data: enterprises } = await supabase
    .from('enterprise_accounts')
    .select('id, name, slug, created_at')
    .order('name', { ascending: true })

  // One grouped read for member-location counts across all enterprises.
  const { data: memberOrgs } = await supabase
    .from('organizations')
    .select('id, enterprise_account_id')
    .not('enterprise_account_id', 'is', null)

  const countByEnterprise: Record<string, number> = {}
  for (const o of memberOrgs ?? []) {
    const eid = o.enterprise_account_id as string | null
    if (eid) countByEnterprise[eid] = (countByEnterprise[eid] ?? 0) + 1
  }

  const list = enterprises ?? []

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-aurea-ink">Enterprises</h1>
          <p className="text-aurea-ink-2 text-sm mt-1">
            DSO / multi-location accounts. Each location bills independently;
            enterprises group them for admin and rolled-up reporting. {list.length} total.
          </p>
        </div>
        <AddEnterpriseButton />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {list.map((ent) => (
          <Link key={ent.id} href={`/agency/enterprises/${ent.id}`} className="group block">
            <Card className="bg-aurea-surface border-aurea-border hover:border-aurea-border-strong hover:shadow-sm transition-all duration-200 h-full">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="h-10 w-10 shrink-0 rounded-xl bg-aurea-surface-2 flex items-center justify-center border border-aurea-border group-hover:border-aurea-primary/30 transition-colors">
                      <Network className="h-5 w-5 text-aurea-ink-3" />
                    </div>
                    <div className="min-w-0">
                      <CardTitle className="text-aurea-ink text-sm truncate">{ent.name}</CardTitle>
                      <CardDescription className="text-aurea-ink-3 text-xs mt-0.5 truncate">
                        /{ent.slug}
                      </CardDescription>
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-aurea-ink-3 group-hover:text-aurea-ink transition-colors shrink-0" />
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-xs text-aurea-ink-2">
                    <Building2 className="h-3.5 w-3.5 text-aurea-ink-3" />
                    Locations
                  </span>
                  <Badge className="bg-aurea-primary/10 text-aurea-primary border border-aurea-primary/20 text-[11px]">
                    {countByEnterprise[ent.id] ?? 0}
                  </Badge>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {list.length === 0 && (
        <div className="rounded-xl border border-dashed border-aurea-border p-12 text-center">
          <Network className="h-10 w-10 text-aurea-ink-3 mx-auto mb-3" />
          <h3 className="text-sm font-medium text-aurea-ink-2">No enterprises yet</h3>
          <p className="text-xs text-aurea-ink-3 mt-1">
            Create an enterprise, then onboard its locations from the Practices page.
          </p>
        </div>
      )}
    </div>
  )
}
