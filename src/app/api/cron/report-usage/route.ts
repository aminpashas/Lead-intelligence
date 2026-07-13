/**
 * Report yesterday's metered usage to Stripe Billing Meters.
 *
 * Each active metered subscriber's usage for the completed prior UTC day is priced through the
 * same engine the panels/invoices use (loadLiveSpend → cost × markup) and sent to Stripe as one
 * meter event per service, valued in billable cents (Stripe prices each meter at 1¢/unit, so the
 * invoice line = billable dollars). Markup lives in one place; the meter never re-derives it.
 *
 * Idempotent: each event's identifier is `${customer}:${service}:${date}`, which Stripe dedupes,
 * so a retry or redeploy never double-bills the same day. Reporting a *complete* prior day (not
 * "today so far") is what makes that safe — run once daily after midnight.
 *
 * Schedule: daily 00:30 UTC (vercel.json).
 */

import Stripe from 'stripe'
import { withCron } from '@/lib/cron/with-cron'
import { loadLiveSpend } from '@/lib/billing/usage-live'
import { buildMeterEvents, sendMeterEvents } from '@/lib/billing/stripe-meters'
import { isTierId, METERED_SERVICES } from '@/lib/billing/tiers'
import { logger } from '@/lib/logger'

/** Prior full UTC day as [start, end) plus its 'YYYY-MM-DD' label and a midday timestamp (secs). */
function priorUtcDay(now: Date): { start: Date; end: Date; date: string; timestampSec: number } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) // today 00:00Z
  const start = new Date(end.getTime() - 86_400_000) // yesterday 00:00Z
  const date = start.toISOString().slice(0, 10)
  const timestampSec = Math.floor((start.getTime() + 43_200_000) / 1000) // midday yesterday, inside the day
  return { start, end, date, timestampSec }
}

export const POST = withCron('report-usage', async ({ supabase }) => {
  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) return { status: 'skipped', items: 0, data: { reason: 'stripe_not_configured' } }

  // Active metered subscribers only: a sellable tier + a Stripe customer to attribute usage to.
  const { data: orgs } = await supabase
    .from('organizations')
    .select('id, stripe_customer_id, subscription_tier, subscription_status')
    .eq('subscription_status', 'active')
    .not('stripe_customer_id', 'is', null)
  type OrgRow = { id: string; stripe_customer_id: string | null; subscription_tier: string; subscription_status: string }
  const subscribers = ((orgs ?? []) as OrgRow[]).filter(
    (o) => isTierId(o.subscription_tier) && o.stripe_customer_id,
  ) as Array<{ id: string; stripe_customer_id: string }>

  if (subscribers.length === 0) return { status: 'ok', items: 0, data: { reason: 'no_metered_subscribers' } }

  const { start, end, date, timestampSec } = priorUtcDay(new Date())

  // Price the whole day for every org in one rollup (service_role is allowed post-migration).
  const spend = await loadLiveSpend(supabase, { since: start, until: end })

  const stripe = new Stripe(secretKey)
  const customerById = new Map(subscribers.map((s) => [s.id, s.stripe_customer_id]))

  let sent = 0
  let orgsBilled = 0
  const errors: Array<{ organizationId: string; identifier: string; message: string }> = []

  for (const [orgId, customerId] of customerById) {
    const usage = spend.byOrg[orgId]
    if (!usage) continue // no usage yesterday → nothing to meter

    const billable = Object.fromEntries(
      METERED_SERVICES.map((service) => [service, usage.services[service]?.billableCents ?? 0]),
    )
    const events = buildMeterEvents({ stripeCustomerId: customerId, date, billable, timestamp: timestampSec })
    if (events.length === 0) continue

    const res = await sendMeterEvents(stripe, events)
    sent += res.sent
    if (res.sent > 0) orgsBilled += 1
    for (const e of res.errors) errors.push({ organizationId: orgId, ...e })
  }

  if (errors.length > 0) {
    logger.warn('report-usage: some meter events failed', { date, failed: errors.length, sample: errors.slice(0, 5) })
  }

  return {
    status: errors.length > 0 ? 'failed' : 'ok',
    items: sent,
    data: { date, orgsBilled, eventsSent: sent, errors: errors.length },
  }
})

// Vercel Cron invokes cron routes with a GET request; alias it to the POST
// handler so this scheduled route actually runs (matches every other cron route).
export const GET = POST
