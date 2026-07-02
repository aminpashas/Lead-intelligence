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
 * Platform default markups (percent). AI carries the highest markup — its raw provider cost is
 * a fraction of a cent while the value it drives is high — and telephony sits lower, closer to
 * a commodity pass-through. Tunable per practice in the agency dashboard.
 */
export const DEFAULT_MARKUP_PCT: Record<BillableService, number> = {
  ai: 50,
  sms: 40,
  voice: 30,
  email: 40,
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
