import { createClient } from '@/lib/supabase/server'
import { Wrench, AlertTriangle, CircleDot, CheckCircle2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import type { AIImprovementTicket } from '@/types/database'
import { TicketsClient } from './tickets-client'

export const metadata = {
  title: 'AI Improvements | Agency | Lead Intelligence',
}

// Ticket triage must always show current state — never a cached page.
export const dynamic = 'force-dynamic'

export default async function AgencyAiImprovementsPage() {
  const supabase = await createClient()

  // RLS restricts this to agency admins; org names joined for context.
  const { data: rows } = await supabase
    .from('ai_improvement_tickets')
    .select('*, organizations(name)')
    .order('created_at', { ascending: false })
    .limit(200)

  const tickets = (rows ?? []) as Array<AIImprovementTicket & { organizations: { name: string } | null }>
  const live = tickets.filter((t) => !['resolved', 'dismissed'].includes(t.status))
  const critical = live.filter((t) => t.severity === 'critical')
  const resolved = tickets.filter((t) => t.status === 'resolved')

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Wrench className="h-5 w-5 text-aurea-primary" />
          <h1 className="text-2xl font-bold text-aurea-ink">AI Improvements</h1>
        </div>
        <p className="text-aurea-ink-2 text-sm">
          Support tickets the AI raises about itself — technical findings from post-call reviews and
          system checks, each with a recommendation and action plan for the engineering team.
        </p>
      </div>

      {/* Summary KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="bg-aurea-surface border-aurea-border">
          <CardContent className="pt-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-aurea-ink-3 mb-1">Open Tickets</p>
                <p className="text-3xl font-bold text-aurea-ink">{live.length}</p>
                <p className="text-xs text-aurea-ink-3 mt-0.5">awaiting action</p>
              </div>
              <CircleDot className="h-8 w-8 text-aurea-primary/30" />
            </div>
          </CardContent>
        </Card>
        <Card className="bg-aurea-surface border-aurea-border">
          <CardContent className="pt-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-aurea-ink-3 mb-1">Critical</p>
                <p className="text-3xl font-bold text-aurea-rose">{critical.length}</p>
                <p className="text-xs text-aurea-ink-3 mt-0.5">need attention now</p>
              </div>
              <AlertTriangle className="h-8 w-8 text-aurea-rose/30" />
            </div>
          </CardContent>
        </Card>
        <Card className="bg-aurea-surface border-aurea-border">
          <CardContent className="pt-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-aurea-ink-3 mb-1">Resolved</p>
                <p className="text-3xl font-bold text-aurea-primary">{resolved.length}</p>
                <p className="text-xs text-aurea-ink-3 mt-0.5">of {tickets.length} total</p>
              </div>
              <CheckCircle2 className="h-8 w-8 text-aurea-primary/30" />
            </div>
          </CardContent>
        </Card>
      </div>

      <TicketsClient
        tickets={tickets.map((t) => ({
          ...t,
          org_name: t.organizations?.name ?? null,
        }))}
      />
    </div>
  )
}
