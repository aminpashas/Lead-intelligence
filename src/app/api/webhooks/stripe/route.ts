/**
 * Stripe webhook handler.
 *
 * Subscribes to:
 *   - payment_intent.succeeded   → cash/card payment captured
 *   - invoice.paid               → recurring subscription invoice settled
 *   - charge.succeeded           → standalone charge (older API path; some integrations still use)
 *   - checkout.session.completed → text-to-pay / payment link checkouts
 *
 * For each event:
 *   1. Verify signature via Stripe SDK.
 *   2. Resolve which org owns the signing secret.
 *   3. Match the Stripe customer/email/phone to a lead via email_hash / phone_hash.
 *   4. Insert into stripe_payments (idempotent on stripe_event_id).
 *   5. Emit `lead.payment.received` event into the events table — the existing
 *      forward-events cron ships it to Meta CAPI / Google Ads as Purchase.
 *
 * Brief: §4.2.
 */

import { NextRequest, NextResponse } from 'next/server'
import type Stripe from 'stripe'
import { createServiceClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { identifyOrgFromStripeSignature, getStripeClient, type StripeConfig } from '@/lib/stripe/client'
import { searchHash } from '@/lib/encryption'
import { logger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.webhook)
  if (rlError) return rlError

  const rawBody = await request.text()
  const signature = request.headers.get('stripe-signature') || ''

  if (!signature) {
    return new NextResponse('Missing Stripe-Signature', { status: 401 })
  }

  const supabase = createServiceClient()

  // Step 1+2: verify signature AND identify which org this event belongs to.
  const identified = await identifyOrgFromStripeSignature(supabase, rawBody, signature)
  if (!identified) {
    return new NextResponse('Invalid signature or no matching org config', { status: 401 })
  }

  const { organizationId, event, config } = identified

  // Audit log every event regardless of whether we process it.
  await supabase.from('stripe_webhook_events').insert({
    organization_id: organizationId,
    stripe_event_id: event.id,
    event_type: event.type,
    status: 'received',
    raw_payload: event as unknown as Record<string, unknown>,
  })

  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object as Stripe.PaymentIntent
        await ingestPayment(supabase, organizationId, {
          eventId: event.id,
          objectId: pi.id,
          objectType: 'payment_intent',
          customerId: typeof pi.customer === 'string' ? pi.customer : pi.customer?.id || null,
          amountCents: pi.amount_received || pi.amount,
          currency: (pi.currency || 'usd').toUpperCase(),
          email: pi.receipt_email || null,
          metadata: pi.metadata || {},
          status: pi.status,
          occurredAt: new Date(event.created * 1000).toISOString(),
          rawEvent: event,
          config,
        })
        break
      }

      case 'invoice.paid': {
        const inv = event.data.object as Stripe.Invoice
        await ingestPayment(supabase, organizationId, {
          eventId: event.id,
          objectId: inv.id || `inv_${event.id}`,
          objectType: 'invoice',
          customerId: typeof inv.customer === 'string' ? inv.customer : inv.customer?.id || null,
          amountCents: inv.amount_paid,
          currency: (inv.currency || 'usd').toUpperCase(),
          email: inv.customer_email || null,
          metadata: inv.metadata || {},
          status: inv.status || 'paid',
          occurredAt: new Date(event.created * 1000).toISOString(),
          rawEvent: event,
          config,
        })
        break
      }

      case 'charge.succeeded': {
        const ch = event.data.object as Stripe.Charge
        // Avoid double-counting if the charge belongs to a payment_intent we already processed.
        if (ch.payment_intent) {
          await markEventStatus(supabase, event.id, 'ignored', 'has_payment_intent')
          break
        }
        await ingestPayment(supabase, organizationId, {
          eventId: event.id,
          objectId: ch.id,
          objectType: 'charge',
          customerId: typeof ch.customer === 'string' ? ch.customer : ch.customer?.id || null,
          amountCents: ch.amount,
          currency: (ch.currency || 'usd').toUpperCase(),
          email: ch.billing_details?.email || ch.receipt_email || null,
          metadata: ch.metadata || {},
          status: ch.status,
          occurredAt: new Date(event.created * 1000).toISOString(),
          rawEvent: event,
          config,
        })
        break
      }

      case 'checkout.session.completed': {
        const sess = event.data.object as Stripe.Checkout.Session
        if ((sess.payment_status as string) !== 'paid') {
          await markEventStatus(supabase, event.id, 'ignored', `not_paid_${sess.payment_status}`)
          break
        }
        await ingestPayment(supabase, organizationId, {
          eventId: event.id,
          objectId: sess.id,
          objectType: 'checkout_session',
          customerId: typeof sess.customer === 'string' ? sess.customer : sess.customer?.id || null,
          amountCents: sess.amount_total || 0,
          currency: (sess.currency || 'usd').toUpperCase(),
          email: sess.customer_details?.email || sess.customer_email || null,
          metadata: sess.metadata || {},
          status: sess.payment_status as string,
          occurredAt: new Date(event.created * 1000).toISOString(),
          rawEvent: event,
          config,
        })
        break
      }

      default: {
        await markEventStatus(supabase, event.id, 'ignored', `unhandled_${event.type}`)
      }
    }

    await markEventStatus(supabase, event.id, 'processed')
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown'
    logger.error('Stripe webhook processing failed', { eventId: event.id, type: event.type, err: message })
    await markEventStatus(supabase, event.id, 'failed', message)
    // Return 200 anyway — Stripe will retry, but our row is already inserted, so retries are idempotent.
  }

  return NextResponse.json({ received: true })
}

// ── handlers ────────────────────────────────────────────────────

type IngestParams = {
  eventId: string
  objectId: string
  objectType: 'payment_intent' | 'invoice' | 'charge' | 'checkout_session' | 'subscription'
  customerId: string | null
  amountCents: number
  currency: string
  email: string | null
  metadata: Record<string, string>
  status: string
  occurredAt: string
  rawEvent: Stripe.Event
  config: StripeConfig
}

async function ingestPayment(
  supabase: ReturnType<typeof createServiceClient>,
  organizationId: string,
  params: IngestParams
): Promise<void> {
  if (!params.amountCents || params.amountCents <= 0) {
    return
  }

  // Try to enrich email/phone from the Stripe customer if we have a customer ID and no email yet.
  let email = params.email
  let phone: string | null = null
  if (params.customerId) {
    try {
      const stripe = getStripeClient(params.config)
      const customer = await stripe.customers.retrieve(params.customerId) as Stripe.Customer
      if (!customer.deleted) {
        if (!email) email = customer.email || null
        phone = customer.phone || null
      }
    } catch {
      // Don't fail the webhook on a customer lookup error.
    }
  }

  const emailHash = email ? searchHash(email.toLowerCase().trim()) : null
  const phoneE164 = phone ? toE164(phone) : null
  const phoneHash = phoneE164 ? searchHash(phoneE164) : null

  // Match to a lead via email_hash → phone_hash.
  let leadId: string | null = null
  let matchMethod: 'email_hash' | 'phone_hash' | 'unmatched' = 'unmatched'
  if (emailHash) {
    const { data } = await supabase
      .from('leads')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('email_hash', emailHash)
      .limit(1)
      .maybeSingle()
    if (data?.id) {
      leadId = data.id as string
      matchMethod = 'email_hash'
    }
  }
  if (!leadId && phoneHash) {
    const { data } = await supabase
      .from('leads')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('phone_hash', phoneHash)
      .limit(1)
      .maybeSingle()
    if (data?.id) {
      leadId = data.id as string
      matchMethod = 'phone_hash'
    }
  }

  // Also try linking to a CareStack patient (table only exists if migration 026 ran).
  let patientId: string | null = null
  if (emailHash) {
    const { data } = await supabase
      .from('patients')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('email_hash', emailHash)
      .limit(1)
      .maybeSingle()
    if (data?.id) patientId = data.id as string
  }

  // Financing partner tag (Sunbit / CareCredit etc.) lives in metadata.
  const financingPartner = (params.metadata[params.config.financing_partner_metadata_key] as string) || null

  // Idempotent insert keyed on stripe_event_id.
  const { data: inserted, error } = await supabase
    .from('stripe_payments')
    .upsert(
      {
        organization_id: organizationId,
        stripe_event_id: params.eventId,
        stripe_object_id: params.objectId,
        stripe_object_type: params.objectType,
        stripe_customer_id: params.customerId,
        amount_cents: params.amountCents,
        currency: params.currency,
        email,
        email_hash: emailHash,
        phone: phoneE164,
        phone_hash: phoneHash,
        lead_id: leadId,
        patient_id: patientId,
        match_method: matchMethod,
        financing_partner: financingPartner,
        status: params.status,
        occurred_at: params.occurredAt,
        metadata: params.metadata,
        raw_payload: params.rawEvent as unknown as Record<string, unknown>,
      },
      { onConflict: 'organization_id,stripe_event_id' }
    )
    .select('id, forwarded')
    .single()

  if (error || !inserted) return

  // Emit lead.payment.received once per row.
  if (!inserted.forwarded) {
    await supabase.from('events').insert({
      organization_id: organizationId,
      lead_id: leadId,
      event_type: 'lead.payment.received',
      payload: {
        source: 'stripe',
        stripe_event_id: params.eventId,
        stripe_object_id: params.objectId,
        stripe_object_type: params.objectType,
        value: params.amountCents / 100,
        currency: params.currency,
        financing_partner: financingPartner,
        match_method: matchMethod,
      },
      occurred_at: params.occurredAt,
    })
    await supabase
      .from('stripe_payments')
      .update({ forwarded: true, forwarded_at: new Date().toISOString() })
      .eq('id', inserted.id)
  }
}

async function markEventStatus(
  supabase: ReturnType<typeof createServiceClient>,
  eventId: string,
  status: 'received' | 'processed' | 'ignored' | 'failed',
  errorMessage?: string
): Promise<void> {
  try {
    await supabase
      .from('stripe_webhook_events')
      .update({ status, error_message: errorMessage ?? null })
      .eq('stripe_event_id', eventId)
  } catch {
    // best-effort
  }
}

function toE164(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (!digits) return phone
  if (phone.startsWith('+')) return `+${digits}`
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return `+${digits}`
}
