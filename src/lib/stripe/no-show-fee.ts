/**
 * No-Show Fee — card-on-file (Stripe SetupIntent) + off-session charge.
 *
 * Flow:
 *   1. At booking, if the practice has no_show_fee_enabled, we create a hosted
 *      Stripe Checkout session in `mode: 'setup'` (saves a card, charges nothing)
 *      and text/email the patient the link. The disclosure states the $50 fee
 *      applies only to a no-show.
 *   2. On checkout.session.completed (mode=setup) the webhook stores
 *      stripe_customer_id + stripe_payment_method_id + card_on_file=true on the
 *      appointment.
 *   3. If the appointment is later marked `no_show`, PATCH /api/appointments
 *      charges the saved card off-session via chargeNoShowFeeForAppointment().
 *
 * This module never throws into a booking flow — callers treat a null/error
 * result as "no card link sent" and continue. The booking itself must not fail
 * because Stripe is misconfigured.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getStripeConfig, getStripeClient } from './client'
import { sendSMSToLead } from '@/lib/messaging/twilio'
import { logger } from '@/lib/logger'

function appBaseUrl(): string | null {
  const url = process.env.NEXT_PUBLIC_APP_URL
  return url ? url.replace(/\/$/, '') : null
}

/**
 * Create a hosted Stripe Checkout session (setup mode) that saves a card on file
 * for this appointment's no-show fee. Returns the URL to send the patient, or
 * null if Stripe isn't configured or the base URL is missing.
 */
export async function createCardCaptureSession(
  supabase: SupabaseClient,
  organizationId: string,
  params: {
    appointmentId: string
    leadId: string
    feeCents: number
    email?: string | null
    name?: string | null
  }
): Promise<{ url: string; customerId: string } | null> {
  const base = appBaseUrl()
  if (!base) {
    logger.warn('No-show card capture skipped: NEXT_PUBLIC_APP_URL not set', { organizationId })
    return null
  }

  const config = await getStripeConfig(supabase, organizationId)
  if (!config) return null

  const stripe = getStripeClient(config)
  const feeDollars = Math.round(params.feeCents / 100)

  // One customer per appointment card-capture; the id is stored on the
  // appointment so the later off-session charge targets the right card.
  const customer = await stripe.customers.create({
    email: params.email || undefined,
    name: params.name || undefined,
    metadata: { organization_id: organizationId, appointment_id: params.appointmentId, lead_id: params.leadId },
  })

  const session = await stripe.checkout.sessions.create({
    mode: 'setup',
    customer: customer.id,
    payment_method_types: ['card'],
    success_url: `${base}/book/${organizationId}?card=saved`,
    cancel_url: `${base}/book/${organizationId}?card=canceled`,
    metadata: {
      purpose: 'no_show_card_on_file',
      organization_id: organizationId,
      appointment_id: params.appointmentId,
      lead_id: params.leadId,
    },
    custom_text: {
      submit: {
        message: `Your consultation is free. A $${feeDollars} fee applies only if you miss your appointment without notice. Your card is saved securely and not charged now.`,
      },
    },
  })

  return session.url ? { url: session.url, customerId: customer.id } : null
}

/**
 * Best-effort: create a card-capture session and text the patient the link.
 * Called right after a consultation is booked when no_show_fee_enabled. Returns
 * true if a link was sent. Never throws — a Stripe failure must not fail booking.
 */
export async function sendCardCaptureLink(
  supabase: SupabaseClient,
  organizationId: string,
  params: {
    appointmentId: string
    leadId: string
    feeCents: number
    phone?: string | null
    email?: string | null
    name?: string | null
    orgName?: string | null
  }
): Promise<boolean> {
  try {
    if (!params.phone) return false // SMS is our delivery channel; no phone → nothing to send.

    const session = await createCardCaptureSession(supabase, organizationId, {
      appointmentId: params.appointmentId,
      leadId: params.leadId,
      feeCents: params.feeCents,
      email: params.email,
      name: params.name,
    })
    if (!session) return false

    const feeDollars = Math.round(params.feeCents / 100)
    const practice = params.orgName || 'our practice'

    await sendSMSToLead({
      supabase,
      leadId: params.leadId,
      to: params.phone,
      body: `To reserve your complimentary consultation at ${practice}, please add a card on file here: ${session.url} — you're only charged a $${feeDollars} fee if you miss the appointment without notice.`,
      caller: 'no_show_fee.card_capture',
    }).catch(() => { /* consent denial handled inside the gate */ })

    await supabase.from('lead_activities').insert({
      organization_id: organizationId,
      lead_id: params.leadId,
      activity_type: 'card_capture_link_sent',
      title: 'Card-on-file link sent for no-show fee',
      metadata: { appointment_id: params.appointmentId, fee_cents: params.feeCents },
    })

    return true
  } catch (err) {
    logger.error('sendCardCaptureLink failed', { organizationId, appointmentId: params.appointmentId, err: err instanceof Error ? err.message : 'unknown' })
    return false
  }
}

export type ChargeResult =
  | { ok: true; paymentIntentId: string }
  | { ok: false; error: string }

/**
 * Charge the saved card off-session for a no-show. The caller is responsible for
 * status idempotency (only call when no_show_fee_status !== 'charged') and for
 * persisting the result onto the appointment.
 *
 * Money-movement safety: the PaymentIntent is created with a deterministic
 * `idempotencyKey` per appointment, so even if two callers (the inline PATCH path
 * and the sweeper cron) race, or a caller retries after its status write failed,
 * Stripe returns the SAME PaymentIntent instead of charging the card twice.
 *
 * On success this ALSO records the charge closed-loop (stripe_payments + events)
 * so a no-show fee reaches the same Meta CAPI / Google Ads / DGS forwarders as any
 * other payment — the off-session charge never produces a Stripe webhook we ingest.
 */
export async function chargeNoShowFeeForAppointment(
  supabase: SupabaseClient,
  organizationId: string,
  appointment: {
    id: string
    lead_id?: string | null
    stripe_customer_id: string | null
    stripe_payment_method_id: string | null
    no_show_fee_cents: number | null
  }
): Promise<ChargeResult> {
  if (!appointment.stripe_customer_id || !appointment.stripe_payment_method_id) {
    return { ok: false, error: 'no_card_on_file' }
  }
  const amount = appointment.no_show_fee_cents
  if (!amount || amount <= 0) return { ok: false, error: 'no_fee_amount' }

  const config = await getStripeConfig(supabase, organizationId)
  if (!config) return { ok: false, error: 'stripe_not_configured' }

  const stripe = getStripeClient(config)
  try {
    const pi = await stripe.paymentIntents.create(
      {
        amount,
        currency: 'usd',
        customer: appointment.stripe_customer_id,
        payment_method: appointment.stripe_payment_method_id,
        off_session: true,
        confirm: true,
        metadata: {
          purpose: 'no_show_fee',
          organization_id: organizationId,
          appointment_id: appointment.id,
        },
      },
      // One no-show fee per appointment — this key makes a duplicate create a
      // no-op that returns the original PaymentIntent instead of a second charge.
      { idempotencyKey: `no_show_fee_${appointment.id}` }
    )

    // Closed-loop record (best-effort; never masks a successful charge).
    await recordNoShowCharge(supabase, organizationId, {
      leadId: appointment.lead_id ?? null,
      appointmentId: appointment.id,
      paymentIntentId: pi.id,
      amountCents: amount,
      stripeCustomerId: appointment.stripe_customer_id,
    })

    return { ok: true, paymentIntentId: pi.id }
  } catch (err) {
    // Card declined / authentication_required / etc. surface as a failed status
    // so staff can follow up; nothing is recorded closed-loop for a failure.
    return { ok: false, error: err instanceof Error ? err.message : 'charge_failed' }
  }
}

/**
 * Record a successful no-show charge into stripe_payments + events, mirroring the
 * webhook's ingestPayment path so the charge is forwarded to Meta CAPI / Google
 * Ads / DGS exactly like a webhook-ingested payment.
 *
 * Idempotent on two levels, matching the webhook:
 *   1. stripe_payments upsert is keyed on (organization_id, stripe_event_id) with a
 *      deterministic synthetic id `noshow_<paymentIntentId>` — re-runs never dup.
 *   2. the events emit is guarded by the row's `forwarded` flag, so a re-run never
 *      double-emits lead.payment.received.
 *
 * Never throws — a closed-loop bookkeeping failure must not fail the charge that
 * already moved money.
 */
export async function recordNoShowCharge(
  supabase: SupabaseClient,
  organizationId: string,
  params: {
    leadId: string | null
    appointmentId: string
    paymentIntentId: string
    amountCents: number
    stripeCustomerId: string | null
  }
): Promise<void> {
  try {
    const occurredAt = new Date().toISOString()
    // Synthetic event id — there is no real Stripe evt_* for an off-session charge
    // we initiated. Deterministic per PaymentIntent preserves the onConflict guard.
    const syntheticEventId = `noshow_${params.paymentIntentId}`

    const { data: inserted, error } = await supabase
      .from('stripe_payments')
      .upsert(
        {
          organization_id: organizationId,
          stripe_event_id: syntheticEventId,
          stripe_object_id: params.paymentIntentId,
          stripe_object_type: 'payment_intent',
          stripe_customer_id: params.stripeCustomerId,
          amount_cents: params.amountCents,
          currency: 'USD',
          lead_id: params.leadId,
          // 'manual' = we attributed this payment to a known lead directly (the
          // appointment carries lead_id), not via an email/phone hash match.
          // ('no_show_fee' is not an allowed match_method value; the semantics
          // live in metadata.purpose below.)
          match_method: 'manual',
          status: 'succeeded',
          occurred_at: occurredAt,
          metadata: { purpose: 'no_show_fee', appointment_id: params.appointmentId },
        },
        { onConflict: 'organization_id,stripe_event_id' }
      )
      .select('id, forwarded')
      .single()

    if (error || !inserted) {
      logger.error('recordNoShowCharge: stripe_payments upsert failed', {
        organizationId,
        appointmentId: params.appointmentId,
        err: error?.message,
      })
      return
    }

    // Emit lead.payment.received once per row (same guard as the webhook).
    if (!inserted.forwarded) {
      await supabase.from('events').insert({
        organization_id: organizationId,
        lead_id: params.leadId,
        event_type: 'lead.payment.received',
        payload: {
          source: 'stripe',
          value: params.amountCents / 100,
          currency: 'USD',
          purpose: 'no_show_fee',
          appointment_id: params.appointmentId,
          payment_intent_id: params.paymentIntentId,
        },
        occurred_at: occurredAt,
      })
      await supabase
        .from('stripe_payments')
        .update({ forwarded: true, forwarded_at: new Date().toISOString() })
        .eq('id', inserted.id)
    }
  } catch (err) {
    logger.error('recordNoShowCharge failed', {
      organizationId,
      appointmentId: params.appointmentId,
      err: err instanceof Error ? err.message : 'unknown',
    })
  }
}
