/**
 * Usage-invoice auto-charging via Stripe Invoices.
 *
 * Charges the practice for a composed usage invoice on the platform Stripe account, using a Stripe
 * Invoice with collection_method 'charge_automatically' against the practice's saved card
 * (billing_settings.stripe_customer_id / stripe_default_pm_id). Produces a customer-facing Stripe
 * invoice + hosted receipt and lets Stripe handle retries/dunning.
 *
 * Dormant by default: returns a typed error (never throws) when there's no customer/card, so the
 * cron and the manual action simply no-op with a reason instead of failing. The `invoice.paid`
 * webhook flips the local invoice to 'paid'; this function also reflects an immediate paid status.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getStripeConfig, getStripeClient } from '@/lib/stripe/client'

export type ChargeInvoiceResult =
  | { ok: true; stripeInvoiceId: string; hostedUrl: string | null; status: string }
  | { ok: false; error: string }

export async function chargeUsageInvoice(
  supabase: SupabaseClient,
  invoiceId: string,
): Promise<ChargeInvoiceResult> {
  const { data: inv } = await supabase
    .from('usage_invoices')
    .select('id, organization_id, period_start, period_end, usage_billable_cents, platform_fee_cents, total_cents, status, stripe_invoice_id')
    .eq('id', invoiceId)
    .maybeSingle()

  if (!inv) return { ok: false, error: 'invoice_not_found' }
  if (inv.status === 'void') return { ok: false, error: 'invoice_void' }
  if (inv.stripe_invoice_id) return { ok: false, error: 'already_charged' }
  if (Number(inv.total_cents) <= 0) return { ok: false, error: 'zero_total' }

  const { data: bs } = await supabase
    .from('billing_settings')
    .select('stripe_customer_id, stripe_default_pm_id')
    .eq('organization_id', inv.organization_id)
    .maybeSingle()

  if (!bs?.stripe_customer_id) return { ok: false, error: 'no_card_on_file' }

  const config = await getStripeConfig(supabase, inv.organization_id as string)
  if (!config) return { ok: false, error: 'stripe_not_configured' }
  const stripe = getStripeClient(config)

  const customer = bs.stripe_customer_id as string
  const usage = Math.round(Number(inv.usage_billable_cents ?? 0))
  const fee = Math.round(Number(inv.platform_fee_cents ?? 0))

  try {
    // Pending invoice items are swept onto the next invoice for this customer.
    if (usage > 0) {
      await stripe.invoiceItems.create({
        customer,
        amount: usage,
        currency: 'usd',
        description: `Lead Intelligence usage · ${inv.period_start} – ${inv.period_end}`,
      })
    }
    if (fee > 0) {
      await stripe.invoiceItems.create({ customer, amount: fee, currency: 'usd', description: 'Platform fee' })
    }

    const created = await stripe.invoices.create({
      customer,
      collection_method: 'charge_automatically',
      default_payment_method: (bs.stripe_default_pm_id as string | null) || undefined,
      auto_advance: true,
      metadata: {
        purpose: 'usage_invoice',
        usage_invoice_id: inv.id as string,
        organization_id: inv.organization_id as string,
      },
    })
    if (!created.id) return { ok: false, error: 'stripe_invoice_no_id' }

    const finalized = await stripe.invoices.finalizeInvoice(created.id)
    // Attempt payment now; if it can't settle (e.g. no default PM) it stays 'open' for dunning.
    let result = finalized
    if (finalized.status !== 'paid' && finalized.id) {
      try {
        result = await stripe.invoices.pay(finalized.id)
      } catch {
        /* leave open — Stripe retries / customer pays via hosted invoice */
      }
    }

    const isPaid = result.status === 'paid'
    const nowIso = new Date().toISOString()
    await supabase
      .from('usage_invoices')
      .update({
        stripe_invoice_id: result.id,
        hosted_invoice_url: result.hosted_invoice_url ?? null,
        status: isPaid ? 'paid' : 'issued',
        charged_at: nowIso,
        paid_at: isPaid ? nowIso : null,
        charge_error: null,
        updated_at: nowIso,
      })
      .eq('id', inv.id as string)

    return { ok: true, stripeInvoiceId: result.id as string, hostedUrl: result.hosted_invoice_url ?? null, status: result.status ?? 'open' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'charge_failed'
    await supabase
      .from('usage_invoices')
      .update({ charge_error: msg, updated_at: new Date().toISOString() })
      .eq('id', inv.id as string)
    return { ok: false, error: msg }
  }
}
