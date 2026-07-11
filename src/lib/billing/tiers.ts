/**
 * Subscription tiers — the single source of truth for the customer-facing plan structure.
 *
 * Every tier is a flat monthly **platform fee** (the entry ticket) that includes a fixed number
 * of seats, with $50/mo per additional seat. On top of that, ALL communication is billed as
 * metered usage (SMS, email, AI voice calls, AI tokens) at a uniform high markup — the same
 * markup for every tier, because the value proposition is replacing human staff, not cheaper
 * per-message rates. Usage is the bulk of revenue; the platform fee is deliberately not.
 *
 * This module is consumed by:
 *   - the customer plan cards (settings/billing)         → labels, prices, feature bullets
 *   - the Stripe checkout route                          → base + seat + metered price IDs
 *   - the Stripe billing webhook                          → price ID → tier resolution + fee sync
 *   - the Stripe setup script                             → what products/prices/meters to create
 *
 * The pricing engine (markup.ts / cost-events.ts) stays the one place that turns provider cost
 * into billable dollars; tiers reference it rather than re-deriving usage prices, so a tier
 * change never silently drifts from what the usage engine actually bills.
 */

export type TierId = 'basic' | 'growth' | 'full'

/** Legacy tiers that may still exist on live subscriptions — mapped for back-compat, not sold. */
export type LegacyTierId = 'starter' | 'professional' | 'enterprise'

/** Everything `organizations.subscription_tier` can hold. */
export type SubscriptionTier = 'trial' | TierId | LegacyTierId

/**
 * Feature gates. Each capability unlocks at a tier and stays unlocked above it (tiers are a
 * strict superset ladder). This is the primary middle-tier funnel lever: `ai_autopilot` — the
 * headline "it runs itself" capability — is deliberately withheld from Basic, so anyone who
 * actually wants automation must step up to Growth (the target tier).
 *
 * Tune the business decision here: which capability gates at which tier.
 */
export type Capability =
  | 'ai_drafts' //        AI writes suggested replies a human sends (all tiers)
  | 'ai_autopilot' //     AI sends/answers on its own — the Growth headline
  | 'multi_channel' //    SMS + email + campaigns across channels
  | 'ai_voice' //         inbound/outbound AI phone agent — the Full headline
  | 'analytics' //        analytics dashboard
  | 'api_access' //       API + custom integrations
  | 'hipaa_baa' //        signed HIPAA BAA

export type Tier = {
  id: TierId
  name: string
  /** Flat monthly platform fee in US cents. */
  baseFeeCents: number
  /** Seats bundled into the base fee. */
  includedSeats: number
  /** Marginal cost per seat beyond `includedSeats`, in US cents. */
  perSeatCents: number
  /** Capabilities unlocked at this tier (inclusive of everything below it). */
  capabilities: Capability[]
  /** Customer-facing bullet list for the plan card. */
  highlights: string[]
  /** The middle tier we steer buyers toward — renders the "Most Popular" ribbon. */
  mostPopular?: boolean
}

/** $50/mo per additional seat — uniform across tiers. */
export const PER_SEAT_CENTS = 5_000

/**
 * The ladder. Basic is intentionally thin (no autopilot) so it reads as "starter, not enough";
 * Growth is the target (autopilot + all channels + analytics); Full adds AI voice for practices
 * that want the phones answered by AI too. Prices climb 199 → 399 → 699: the Basic→Growth gap
 * ($200) is smaller than Growth→Full ($300), which nudges the fence-sitter up into Growth.
 */
export const TIERS: Record<TierId, Tier> = {
  basic: {
    id: 'basic',
    name: 'Basic',
    baseFeeCents: 19_900,
    includedSeats: 1,
    perSeatCents: PER_SEAT_CENTS,
    capabilities: ['ai_drafts'],
    highlights: [
      '1 user included ($50/mo per extra)',
      'AI-drafted replies (you send)',
      'Two-way SMS & email',
      'Standard support',
    ],
  },
  growth: {
    id: 'growth',
    name: 'Growth',
    baseFeeCents: 39_900,
    includedSeats: 3,
    perSeatCents: PER_SEAT_CENTS,
    capabilities: ['ai_drafts', 'ai_autopilot', 'multi_channel', 'analytics'],
    highlights: [
      '3 users included ($50/mo per extra)',
      'AI autopilot — replies & follows up on its own',
      'Multi-channel campaigns',
      'Analytics dashboard',
      'Priority support',
    ],
    mostPopular: true,
  },
  full: {
    id: 'full',
    name: 'Full',
    baseFeeCents: 69_900,
    includedSeats: 5,
    perSeatCents: PER_SEAT_CENTS,
    capabilities: ['ai_drafts', 'ai_autopilot', 'multi_channel', 'analytics', 'ai_voice', 'api_access', 'hipaa_baa'],
    highlights: [
      '5 users included ($50/mo per extra)',
      'Everything in Growth, plus:',
      'AI voice agent — answers & places calls',
      'API access & custom integrations',
      'HIPAA BAA',
    ],
  },
}

export const TIER_ORDER: TierId[] = ['basic', 'growth', 'full']

export function isTierId(value: string): value is TierId {
  return value === 'basic' || value === 'growth' || value === 'full'
}

export function getTier(id: TierId): Tier {
  return TIERS[id]
}

/** Does a tier unlock a capability? (Gates are a strict superset ladder.) */
export function tierHasCapability(id: TierId, cap: Capability): boolean {
  return TIERS[id].capabilities.includes(cap)
}

/**
 * Additional (billable) seats for a staff headcount on a tier — never negative. A practice with
 * 4 staff on Growth (3 included) pays for 1 extra seat; on Full (5 included) pays for none.
 */
export function billableSeats(id: TierId, staffCount: number): number {
  return Math.max(0, Math.floor(staffCount) - TIERS[id].includedSeats)
}

/**
 * Recurring monthly platform charge for a tier at a given headcount, in cents: base fee plus
 * $50 for every seat beyond the included allotment. This is the fixed part of the bill only —
 * metered usage (SMS/email/voice/AI) is billed separately on top.
 */
export function monthlyPlatformCents(id: TierId, staffCount: number): number {
  const tier = TIERS[id]
  return tier.baseFeeCents + billableSeats(id, staffCount) * tier.perSeatCents
}

// ── Metered usage services ────────────────────────────────────────────────
//
// The four things billed on top of every tier. These names match the billing engine's
// BillableService union (markup.ts) and each maps to one Stripe Billing Meter. We meter the
// *billable cents* the engine already computes, so the Stripe price is a flat 1¢/unit and the
// markup lives in exactly one place.

export type MeteredService = 'ai' | 'sms' | 'voice' | 'email'

export const METERED_SERVICES: MeteredService[] = ['ai', 'sms', 'voice', 'email']

/** Stripe meter `event_name` per service. Stable identifiers — changing one orphans its meter. */
export const METER_EVENT_NAME: Record<MeteredService, string> = {
  ai: 'li_usage_ai',
  sms: 'li_usage_sms',
  voice: 'li_usage_voice',
  email: 'li_usage_email',
}

/** Customer-facing label for each metered service (plan cards / invoices). */
export const METERED_SERVICE_LABEL: Record<MeteredService, string> = {
  ai: 'AI tokens',
  sms: 'SMS segments',
  voice: 'AI voice minutes',
  email: 'Emails',
}

// ── Stripe price/meter env-var wiring ─────────────────────────────────────
//
// Every Stripe object created by scripts/setup-stripe-billing.ts is referenced by an env var so
// the same code runs against test and live modes. Resolvers return undefined when unset, and
// callers surface a clear "not configured" error rather than charging the wrong thing.

/** Env var holding the base (platform-fee) Stripe price ID for a tier. */
export const TIER_PRICE_ENV: Record<TierId, string> = {
  basic: 'STRIPE_PRICE_BASIC',
  growth: 'STRIPE_PRICE_GROWTH',
  full: 'STRIPE_PRICE_FULL',
}

/** Env var holding the shared per-additional-seat Stripe price ID. */
export const SEAT_PRICE_ENV = 'STRIPE_PRICE_SEAT'

/** Env var holding the metered Stripe price ID for a usage service. */
export const METER_PRICE_ENV: Record<MeteredService, string> = {
  ai: 'STRIPE_PRICE_METER_AI',
  sms: 'STRIPE_PRICE_METER_SMS',
  voice: 'STRIPE_PRICE_METER_VOICE',
  email: 'STRIPE_PRICE_METER_EMAIL',
}

type Env = Record<string, string | undefined>

/** Resolve a tier's base price ID from the environment (undefined when unset). */
export function tierPriceId(id: TierId, env: Env = process.env): string | undefined {
  return env[TIER_PRICE_ENV[id]]
}

export function seatPriceId(env: Env = process.env): string | undefined {
  return env[SEAT_PRICE_ENV]
}

export function meterPriceId(service: MeteredService, env: Env = process.env): string | undefined {
  return env[METER_PRICE_ENV[service]]
}

/**
 * Build the ordered list of subscription line items for a checkout: base (qty 1), the seat price
 * (qty = additional seats, omitted when zero), and every configured metered usage price (no
 * quantity — Stripe reads it from meter events). Throws when the tier's base or any meter price
 * is unconfigured, so a misconfigured environment fails loudly at checkout instead of billing a
 * customer for the platform fee while silently dropping all usage charges.
 */
export function buildSubscriptionItems(
  id: TierId,
  extraSeats: number,
  env: Env = process.env,
): Array<{ price: string; quantity?: number }> {
  const base = tierPriceId(id, env)
  if (!base) throw new Error(`Missing ${TIER_PRICE_ENV[id]} — run scripts/setup-stripe-billing.ts`)

  const items: Array<{ price: string; quantity?: number }> = [{ price: base, quantity: 1 }]

  if (extraSeats > 0) {
    const seat = seatPriceId(env)
    if (!seat) throw new Error(`Missing ${SEAT_PRICE_ENV} — run scripts/setup-stripe-billing.ts`)
    items.push({ price: seat, quantity: extraSeats })
  }

  for (const service of METERED_SERVICES) {
    const price = meterPriceId(service, env)
    if (!price) throw new Error(`Missing ${METER_PRICE_ENV[service]} — run scripts/setup-stripe-billing.ts`)
    items.push({ price }) // metered items carry no quantity
  }

  return items
}
