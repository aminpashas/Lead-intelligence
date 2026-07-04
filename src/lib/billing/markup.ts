/**
 * Re-billing markup — turns "what we pay" (cost_cents) into "what we charge the practice"
 * (billable_cents). The markup percentage is snapshotted onto every ledger row at event time
 * so that later changing a practice's markup never retroactively re-prices past usage.
 *
 * Model: a per-service percentage markup, overridable per practice via billing_settings.markups.
 * A flat monthly platform fee (billing_settings.platform_fee_cents) is separate — applied at
 * invoice aggregation, not per event — so it deliberately does not live here.
 */

export type BillableService = 'ai' | 'sms' | 'voice' | 'email'

/**
 * Platform default markups (percent). House default is a flat 3× re-bill — the practice pays 3×
 * what we pay the provider — expressed as a 200% markup (billable = cost × (1 + 200/100) = cost × 3).
 * Applied uniformly across services; overridable per practice via the agency pricing calculator,
 * which writes `billing_settings.markups`. Keep the vocabularies straight: the field is
 * markup-over-cost (200), not the multiple (3×).
 */
export const DEFAULT_MARKUP_PCT: Record<BillableService, number> = {
  ai: 200,
  sms: 200,
  voice: 200,
  email: 200,
}

/**
 * House default monthly platform fee per practice, in cents ($1,500/mo). This is the flat retainer
 * on top of usage — the primary revenue lever — separate from per-event markup. Applied at invoice
 * aggregation and shown blended in the agency panel; overridable per practice via the pricing
 * calculator (`billing_settings.platform_fee_cents`). A stored 0 means "no fee" and is respected.
 */
export const DEFAULT_PLATFORM_FEE_CENTS = 150_000

/** Resolve a practice's monthly platform fee (cents). A stored non-negative value wins, incl. 0. */
export function resolvePlatformFeeCents(stored?: number | null): number {
  if (typeof stored === 'number' && Number.isFinite(stored) && stored >= 0) return stored
  return DEFAULT_PLATFORM_FEE_CENTS
}

export type MarkupConfig = {
  /** Per-service markup overrides in percent, keyed by service name. */
  markups?: Partial<Record<string, number>> | null
} | null | undefined

function isValidPct(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Resolve the markup percentage for a service, honoring a valid per-practice override. */
export function resolveMarkupPct(service: BillableService, config?: MarkupConfig): number {
  const override = config?.markups?.[service]
  if (isValidPct(override)) return override
  return DEFAULT_MARKUP_PCT[service]
}

/**
 * Compute the billable amount and the markup percentage actually applied.
 * Fractional cents are preserved — rounding a sub-cent AI call to a whole cent would either
 * erase it or 30×-inflate it, so we round only at invoice/display aggregation.
 */
export function computeBillable(
  costCents: number,
  service: BillableService,
  config?: MarkupConfig,
): { billableCents: number; markupPct: number } {
  const markupPct = resolveMarkupPct(service, config)
  const billableCents = costCents * (1 + markupPct / 100)
  return { billableCents, markupPct }
}
