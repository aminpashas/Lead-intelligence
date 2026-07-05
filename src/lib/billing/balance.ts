/**
 * Prepaid usage balance ("credits wallet") + auto-reload.
 *
 * In `prepaid` mode, usage (AI/SMS/voice at markup) is debited from a prepaid balance; when the
 * balance falls to the low threshold (default 10% of the reload amount) the saved card is charged
 * for the reload amount and the balance is topped back up. Reuses usage_rollup (via loadLiveSpend)
 * for the draw-down and the platform Stripe customer/card (billing_settings) for the reload.
 *
 * Money-safety: never throws; a reload only fires when auto_reload is on AND a card is on file.
 * Balance mutations are read-modify-write — fine for the serial cron + rare manual reloads; the
 * ledger (balance_transactions) records every change with the running balance for audit.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadLiveSpend } from './usage-live'
import { getStripeConfig, getStripeClient } from '@/lib/stripe/client'

/** Default top-up when a practice hasn't set a reload amount. */
export const DEFAULT_RELOAD_CENTS = 50_000 // $500

/** The balance at/below which auto-reload fires: `lowBalancePct`% of the reload amount. */
export function computeLowThreshold(reloadAmountCents: number, lowBalancePct: number): number {
  return Math.max(0, reloadAmountCents) * (Math.max(0, lowBalancePct) / 100)
}

export type BalanceState = {
  organizationId: string
  mode: 'invoice' | 'prepaid'
  autoReload: boolean
  balanceCents: number
  reloadAmountCents: number
  lowBalancePct: number
  lowThresholdCents: number
  settledThrough: string | null
  stripeCustomerId: string | null
  stripePmId: string | null
}

const n = (v: unknown): number => {
  const x = typeof v === 'string' ? Number(v) : (v as number) ?? 0
  return Number.isFinite(x) ? x : 0
}

export async function getBalanceState(supabase: SupabaseClient, organizationId: string): Promise<BalanceState> {
  const { data } = await supabase
    .from('billing_settings')
    .select('billing_mode, auto_reload, balance_cents, reload_amount_cents, low_balance_pct, balance_settled_through, stripe_customer_id, stripe_default_pm_id')
    .eq('organization_id', organizationId)
    .maybeSingle()

  const reloadAmountCents = data?.reload_amount_cents ? n(data.reload_amount_cents) : DEFAULT_RELOAD_CENTS
  const lowBalancePct = data?.low_balance_pct != null ? n(data.low_balance_pct) : 10
  return {
    organizationId,
    mode: (data?.billing_mode as 'invoice' | 'prepaid') ?? 'invoice',
    autoReload: (data?.auto_reload as boolean) ?? false,
    balanceCents: n(data?.balance_cents),
    reloadAmountCents,
    lowBalancePct,
    lowThresholdCents: computeLowThreshold(reloadAmountCents, lowBalancePct),
    settledThrough: (data?.balance_settled_through as string | null) ?? null,
    stripeCustomerId: (data?.stripe_customer_id as string | null) ?? null,
    stripePmId: (data?.stripe_default_pm_id as string | null) ?? null,
  }
}

/** Apply a balance change and append a ledger row. Returns the new balance. */
export async function applyBalanceDelta(
  supabase: SupabaseClient,
  organizationId: string,
  deltaCents: number,
  reason: string,
  metadata: Record<string, unknown> = {},
): Promise<number> {
  const state = await getBalanceState(supabase, organizationId)
  const balanceAfter = state.balanceCents + deltaCents
  await supabase
    .from('billing_settings')
    .upsert(
      { organization_id: organizationId, balance_cents: balanceAfter, updated_at: new Date().toISOString() },
      { onConflict: 'organization_id' },
    )
  await supabase.from('balance_transactions').insert({
    organization_id: organizationId,
    kind: deltaCents >= 0 ? 'credit' : 'debit',
    amount_cents: Math.abs(deltaCents),
    reason,
    balance_after: balanceAfter,
    metadata,
  })
  return balanceAfter
}

/**
 * Debit usage accrued since the last settlement. First call for a practice just anchors
 * settled_through = now (no retroactive debit of all history). Returns the amount debited.
 */
export async function settleUsageToBalance(
  supabase: SupabaseClient,
  organizationId: string,
  now: Date,
): Promise<{ debitedCents: number }> {
  const state = await getBalanceState(supabase, organizationId)
  const untilIso = now.toISOString()

  if (!state.settledThrough) {
    await supabase
      .from('billing_settings')
      .upsert(
        { organization_id: organizationId, balance_settled_through: untilIso, updated_at: untilIso },
        { onConflict: 'organization_id' },
      )
    return { debitedCents: 0 }
  }

  const { byOrg } = await loadLiveSpend(supabase, {
    organizationId,
    since: state.settledThrough,
    until: untilIso,
  })
  const usageBillableCents = byOrg[organizationId]?.billableCents ?? 0

  // Always advance the watermark so usage isn't re-counted next run, even if it's $0.
  if (usageBillableCents > 0) {
    await applyBalanceDelta(supabase, organizationId, -usageBillableCents, 'usage', {
      since: state.settledThrough,
      until: untilIso,
    })
  }
  await supabase
    .from('billing_settings')
    .upsert(
      { organization_id: organizationId, balance_settled_through: untilIso, updated_at: untilIso },
      { onConflict: 'organization_id' },
    )

  return { debitedCents: usageBillableCents }
}

export type ReloadResult = { ok: true; amountCents: number; balanceCents: number } | { ok: false; error: string }

/** Charge the saved card for a top-up and credit the balance. Off-session; never throws. */
export async function chargeReload(
  supabase: SupabaseClient,
  organizationId: string,
  amountCents: number,
): Promise<ReloadResult> {
  if (amountCents <= 0) return { ok: false, error: 'zero_amount' }
  const state = await getBalanceState(supabase, organizationId)
  if (!state.stripeCustomerId || !state.stripePmId) return { ok: false, error: 'no_card_on_file' }

  const config = await getStripeConfig(supabase, organizationId)
  if (!config) return { ok: false, error: 'stripe_not_configured' }
  const stripe = getStripeClient(config)

  try {
    const pi = await stripe.paymentIntents.create({
      amount: Math.round(amountCents),
      currency: 'usd',
      customer: state.stripeCustomerId,
      payment_method: state.stripePmId,
      off_session: true,
      confirm: true,
      metadata: { purpose: 'usage_balance_reload', organization_id: organizationId },
    })
    if (pi.status !== 'succeeded') return { ok: false, error: `charge_${pi.status}` }
    const balanceCents = await applyBalanceDelta(supabase, organizationId, amountCents, 'reload', {
      payment_intent: pi.id,
    })
    return { ok: true, amountCents, balanceCents }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'charge_failed' }
  }
}

/** If prepaid + auto_reload + at/below threshold + card on file → reload. Returns what happened. */
export async function reloadIfLow(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<{ reloaded: boolean; reason?: string; result?: ReloadResult }> {
  const state = await getBalanceState(supabase, organizationId)
  if (state.mode !== 'prepaid' || !state.autoReload) return { reloaded: false, reason: 'not_enabled' }
  if (state.balanceCents > state.lowThresholdCents) return { reloaded: false, reason: 'above_threshold' }
  if (!state.stripeCustomerId || !state.stripePmId) return { reloaded: false, reason: 'no_card_on_file' }

  const result = await chargeReload(supabase, organizationId, state.reloadAmountCents)
  return { reloaded: result.ok, reason: result.ok ? undefined : ('error' in result ? result.error : 'failed'), result }
}
