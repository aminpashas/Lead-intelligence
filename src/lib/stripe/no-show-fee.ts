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
 * idempotency (only call when no_show_fee_status !== 'charged') and for
 * persisting the result onto the appointment.
 */
export async function chargeNoShowFeeForAppointment(
  supabase: SupabaseClient,
  organizationId: string,
  appointment: {
    id: string
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
    const pi = await stripe.paymentIntents.create({
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
    })
    return { ok: true, paymentIntentId: pi.id }
  } catch (err) {
    // Card declined / authentication_required / etc. surface as a failed status
    // so staff can follow up; the webhook won't ingest anything for a failure.
    return { ok: false, error: err instanceof Error ? err.message : 'charge_failed' }
  }
}
