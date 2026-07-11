/**
 * Stripe Billing Meters reporting.
 *
 * Usage is billed by metering the **billable cents** the pricing engine already computes (cost ×
 * markup, per markup.ts) and pricing each Stripe meter at a flat 1¢/unit. So a day's billable
 * total for a service becomes a single meter event whose `value` is that cent count, and Stripe's
 * invoice line = value × $0.01 = the marked-up dollars. Markup therefore lives in exactly one
 * place; the meter never re-derives it.
 *
 * Idempotency: each event's `identifier` is `${stripeCustomerId}:${service}:${date}`. Stripe
 * enforces identifier uniqueness for 24h+, so re-running the daily cron (retry, redeploy, manual
 * backfill) overwrites rather than double-counts the same (customer, service, day).
 */

import type Stripe from 'stripe'
import { METER_EVENT_NAME, type MeteredService, METERED_SERVICES } from './tiers'

/** Billable cents per service for one customer over one day (missing/zero services allowed). */
export type DailyBillable = Partial<Record<MeteredService, number>>

export type MeterEventInput = {
  event_name: string
  payload: { value: string; stripe_customer_id: string }
  identifier: string
  timestamp: number
}

/**
 * Turn a customer's daily per-service billable into meter events — one per service with a
 * positive, rounded cent value. Services that round to zero are dropped (no point sending a
 * no-op event). `timestamp` is Unix seconds; it must fall inside the day being reported so the
 * usage lands in the right billing period.
 */
export function buildMeterEvents(args: {
  stripeCustomerId: string
  /** The usage day in 'YYYY-MM-DD' — used only to build the idempotency identifier. */
  date: string
  billable: DailyBillable
  timestamp: number
}): MeterEventInput[] {
  const events: MeterEventInput[] = []
  for (const service of METERED_SERVICES) {
    const value = Math.round(args.billable[service] ?? 0)
    if (value <= 0) continue
    events.push({
      event_name: METER_EVENT_NAME[service],
      payload: { value: String(value), stripe_customer_id: args.stripeCustomerId },
      identifier: `${args.stripeCustomerId}:${service}:${args.date}`,
      timestamp: args.timestamp,
    })
  }
  return events
}

/**
 * Send meter events to Stripe. Best-effort per event: a failure on one service is logged by the
 * caller via the returned error list and does not abort the rest, so one bad service never blocks
 * a whole day's billing. Returns how many succeeded and any per-event errors.
 */
export async function sendMeterEvents(
  stripe: Stripe,
  events: MeterEventInput[],
): Promise<{ sent: number; errors: Array<{ identifier: string; message: string }> }> {
  let sent = 0
  const errors: Array<{ identifier: string; message: string }> = []
  for (const event of events) {
    try {
      await stripe.billing.meterEvents.create(event)
      sent += 1
    } catch (err) {
      errors.push({ identifier: event.identifier, message: err instanceof Error ? err.message : 'Unknown' })
    }
  }
  return { sent, errors }
}
