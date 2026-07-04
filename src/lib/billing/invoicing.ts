/**
 * Usage invoicing — compose a practice's monthly bill from live usage + platform fee, and persist
 * it to `usage_invoices`. An invoice is a *closed* period [start, end): usage re-bill over the
 * period plus the flat monthly platform fee. Composed from the same rate card + markup the panels
 * use (via loadLiveSpend), so a rendered invoice always matches what the dashboards showed.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadLiveSpend, type ServiceLine } from './usage-live'
import { resolvePlatformFeeCents } from './markup'

export type UsageInvoiceLineItem = {
  service: string
  quantity: number
  unit: string
  costCents: number
  billableCents: number
  markupPct: number
}

export type ComposedUsageInvoice = {
  organizationId: string
  periodStart: string // 'YYYY-MM-DD'
  periodEnd: string // 'YYYY-MM-DD' (exclusive)
  usageCostCents: number
  usageBillableCents: number
  platformFeeCents: number
  totalCents: number
  lineItems: UsageInvoiceLineItem[]
}

const UNIT: Record<string, string> = { ai: 'AI actions', sms: 'segments', voice: 'minutes', email: 'emails' }

function quantityFor(service: string, u: { quantities: { smsOutSegments: number; smsInCount: number; voiceSeconds: number; emailOutCount: number; aiCalls: number } }): number {
  if (service === 'sms') return u.quantities.smsOutSegments + u.quantities.smsInCount
  if (service === 'voice') return Math.round(u.quantities.voiceSeconds / 60)
  if (service === 'email') return u.quantities.emailOutCount
  return u.quantities.aiCalls
}

/**
 * Compose (but do not persist) a practice's invoice for a closed period. The platform fee is the
 * FULL monthly fee for a month-length period (not pro-rated), matching a standard monthly bill.
 */
export async function composeUsageInvoice(
  supabase: SupabaseClient,
  args: { organizationId: string; periodStart: string; periodEnd: string },
): Promise<ComposedUsageInvoice> {
  const [{ byOrg }, feeRow] = await Promise.all([
    loadLiveSpend(supabase, {
      organizationId: args.organizationId,
      since: args.periodStart,
      until: args.periodEnd,
    }),
    supabase
      .from('billing_settings')
      .select('platform_fee_cents')
      .eq('organization_id', args.organizationId)
      .maybeSingle(),
  ])

  const u = byOrg[args.organizationId]
  const platformFeeCents = resolvePlatformFeeCents((feeRow.data?.platform_fee_cents as number | null) ?? null)

  const lineItems: UsageInvoiceLineItem[] = u
    ? (['ai', 'sms', 'voice', 'email'] as const)
        .map((service): UsageInvoiceLineItem => {
          const line: ServiceLine = u.services[service]
          return {
            service,
            quantity: quantityFor(service, u),
            unit: UNIT[service],
            costCents: line.costCents,
            billableCents: line.billableCents,
            markupPct: line.markupPct,
          }
        })
        .filter((li) => li.billableCents > 0 || li.quantity > 0)
    : []

  const usageCostCents = u?.costCents ?? 0
  const usageBillableCents = u?.billableCents ?? 0
  const totalCents = usageBillableCents + platformFeeCents

  return {
    organizationId: args.organizationId,
    periodStart: args.periodStart,
    periodEnd: args.periodEnd,
    usageCostCents,
    usageBillableCents,
    platformFeeCents,
    totalCents,
    lineItems,
  }
}

/**
 * Compose and persist an invoice (idempotent upsert by org+period). `status` defaults to 'issued'
 * so the practice can see it immediately; pass 'draft' to stage without exposing it.
 */
export async function generateUsageInvoice(
  supabase: SupabaseClient,
  args: { organizationId: string; periodStart: string; periodEnd: string; status?: 'draft' | 'issued' },
): Promise<{ invoice: ComposedUsageInvoice; id: string | null; error: string | null }> {
  const invoice = await composeUsageInvoice(supabase, args)
  const { data, error } = await supabase
    .from('usage_invoices')
    .upsert(
      {
        organization_id: invoice.organizationId,
        period_start: invoice.periodStart,
        period_end: invoice.periodEnd,
        usage_cost_cents: invoice.usageCostCents,
        usage_billable_cents: invoice.usageBillableCents,
        platform_fee_cents: invoice.platformFeeCents,
        total_cents: invoice.totalCents,
        line_items: invoice.lineItems,
        status: args.status ?? 'issued',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'organization_id,period_start,period_end' },
    )
    .select('id')
    .single()
  return { invoice, id: (data?.id as string) ?? null, error: error ? error.message : null }
}

/** First-of-this-month → first-of-next-month ('YYYY-MM-DD' strings, end exclusive). */
export function currentMonthPeriod(now: Date): { periodStart: string; periodEnd: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return { periodStart: start.toISOString().slice(0, 10), periodEnd: end.toISOString().slice(0, 10) }
}

/** The previous whole calendar month ('YYYY-MM-DD', end exclusive) — what the monthly cron bills. */
export function previousMonthPeriod(now: Date): { periodStart: string; periodEnd: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  return { periodStart: start.toISOString().slice(0, 10), periodEnd: end.toISOString().slice(0, 10) }
}
