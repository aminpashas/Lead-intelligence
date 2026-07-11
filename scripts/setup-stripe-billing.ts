/**
 * One-off (idempotent): provision the Stripe objects the tiered + metered billing model needs, and
 * print the env vars that wire them up. Run once per Stripe mode (test, then live).
 *
 * Creates:
 *   - one recurring base price per tier   (Basic $199 / Growth $399 / Full $699, licensed)
 *   - one shared per-seat price           ($50/mo, licensed — billed by quantity)
 *   - four Billing Meters + metered prices (ai / sms / voice / email, 1¢ per unit)
 *
 * The metered prices are 1¢/unit because we meter the *billable cents* the pricing engine already
 * computes (cost × markup, per src/lib/billing/markup.ts): value × $0.01 = the marked-up dollars.
 * Markup lives in one place; the meter never re-derives it.
 *
 * Idempotency: prices are looked up by `lookup_key` and meters by `event_name`, so re-running never
 * duplicates. It prints (does not write) the env vars — paste the STRIPE_PRICE_* block into your
 * environment (.env.local for test, Vercel for prod), then customers can subscribe.
 *
 * Usage: npx tsx scripts/setup-stripe-billing.ts
 * Env (from .env.local): STRIPE_SECRET_KEY
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import Stripe from 'stripe'
import {
  TIERS,
  TIER_ORDER,
  PER_SEAT_CENTS,
  METERED_SERVICES,
  METER_EVENT_NAME,
  METERED_SERVICE_LABEL,
  TIER_PRICE_ENV,
  SEAT_PRICE_ENV,
  METER_PRICE_ENV,
} from '../src/lib/billing/tiers'

const secretKey = process.env.STRIPE_SECRET_KEY
if (!secretKey) {
  console.error('Missing STRIPE_SECRET_KEY in .env.local')
  process.exit(1)
}
const stripe = new Stripe(secretKey)
const mode = secretKey.startsWith('sk_live') ? 'LIVE' : 'TEST'

/** Find an active meter by event_name, or create it. Returns the meter id. */
async function ensureMeter(eventName: string, displayName: string): Promise<string> {
  const existing = await stripe.billing.meters.list({ status: 'active', limit: 100 })
  const found = existing.data.find((m) => m.event_name === eventName)
  if (found) {
    console.log(`  meter ${eventName} → ${found.id} (exists)`)
    return found.id
  }
  const meter = await stripe.billing.meters.create({
    display_name: displayName,
    event_name: eventName,
    default_aggregation: { formula: 'sum' },
    value_settings: { event_payload_key: 'value' },
    customer_mapping: { type: 'by_id', event_payload_key: 'stripe_customer_id' },
  })
  console.log(`  meter ${eventName} → ${meter.id} (created)`)
  return meter.id
}

/** Find a price by lookup_key, or create it (with an inline product). Returns the price id. */
async function ensurePrice(
  lookupKey: string,
  productName: string,
  params: Omit<Stripe.PriceCreateParams, 'lookup_key' | 'product' | 'product_data' | 'currency'>,
): Promise<string> {
  const existing = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 })
  if (existing.data[0]) {
    console.log(`  price ${lookupKey} → ${existing.data[0].id} (exists)`)
    return existing.data[0].id
  }
  const price = await stripe.prices.create({
    lookup_key: lookupKey,
    currency: 'usd',
    product_data: { name: productName },
    ...params,
  })
  console.log(`  price ${lookupKey} → ${price.id} (created)`)
  return price.id
}

async function main() {
  console.log(`\nProvisioning Stripe billing objects in ${mode} mode…\n`)
  const env: Record<string, string> = {}

  // 1. Base (platform-fee) prices — one per tier, licensed monthly.
  console.log('Base tier prices:')
  for (const id of TIER_ORDER) {
    const tier = TIERS[id]
    env[TIER_PRICE_ENV[id]] = await ensurePrice(`li_base_${id}`, `Lead Intelligence — ${tier.name}`, {
      unit_amount: tier.baseFeeCents,
      recurring: { interval: 'month' },
    })
  }

  // 2. Shared per-additional-seat price, licensed monthly (billed by quantity).
  console.log('\nSeat price:')
  env[SEAT_PRICE_ENV] = await ensurePrice('li_seat', 'Lead Intelligence — Additional Seat', {
    unit_amount: PER_SEAT_CENTS,
    recurring: { interval: 'month' },
  })

  // 3. Meters + metered usage prices (1¢/unit; unit = one cent of billable usage).
  console.log('\nUsage meters + metered prices:')
  for (const service of METERED_SERVICES) {
    const meterId = await ensureMeter(METER_EVENT_NAME[service], `Lead Intelligence ${METERED_SERVICE_LABEL[service]}`)
    env[METER_PRICE_ENV[service]] = await ensurePrice(`li_meter_${service}`, `Lead Intelligence — ${METERED_SERVICE_LABEL[service]} usage`, {
      billing_scheme: 'per_unit',
      unit_amount_decimal: Stripe.Decimal.from('1'), // 1 cent per unit (unit = 1 cent of billable)
      recurring: { interval: 'month', usage_type: 'metered', meter: meterId },
    })
  }

  console.log(`\n✅ Done. Set these env vars (${mode} mode):\n`)
  for (const key of Object.keys(env)) console.log(`${key}=${env[key]}`)
  console.log('')
}

main().catch((err) => {
  console.error('Setup failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
