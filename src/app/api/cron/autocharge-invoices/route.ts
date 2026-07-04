/**
 * Monthly usage-invoice auto-charge.
 *
 * For each practice with `billing_settings.autocharge = true` and a card on file, generate the
 * previous month's usage invoice (issued) and charge it via Stripe. Idempotent: generation upserts
 * by (org, period); charging skips invoices that already have a Stripe invoice id. Practices without
 * autocharge or a card are never touched.
 *
 * Schedule: 08:00 UTC on the 1st of each month (vercel.json).
 */
import { withCron } from '@/lib/cron/with-cron'
import { generateUsageInvoice, previousMonthPeriod } from '@/lib/billing/invoicing'
import { chargeUsageInvoice } from '@/lib/billing/autocharge'

export const POST = withCron('autocharge-invoices', async ({ supabase }) => {
  const { periodStart, periodEnd } = previousMonthPeriod(new Date())

  const { data: settings } = await supabase
    .from('billing_settings')
    .select('organization_id, stripe_customer_id')
    .eq('autocharge', true)
    .not('stripe_customer_id', 'is', null)

  let charged = 0
  let skipped = 0
  let failed = 0

  for (const s of settings ?? []) {
    const orgId = s.organization_id as string
    const { id, error } = await generateUsageInvoice(supabase, {
      organizationId: orgId,
      periodStart,
      periodEnd,
      status: 'issued',
    })
    if (error || !id) {
      failed++
      continue
    }
    const res = await chargeUsageInvoice(supabase, id)
    if (res.ok) charged++
    else if (res.error === 'already_charged' || res.error === 'zero_total') skipped++
    else failed++
  }

  return {
    status: 'ok',
    items: charged,
    data: { periodStart, periodEnd, practices: settings?.length ?? 0, charged, skipped, failed },
  }
})
