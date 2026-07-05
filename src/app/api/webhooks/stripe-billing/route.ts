/**
 * POST /api/webhooks/stripe-billing — Stripe Billing Webhook
 *
 * Handles SaaS subscription lifecycle events (separate from the patient
 * payment webhook at /api/webhooks/stripe which handles payment ingestion).
 *
 * Events:
 *   - checkout.session.completed → activate subscription
 *   - customer.subscription.updated → sync tier/status changes
 *   - customer.subscription.deleted → mark as canceled
 *   - invoice.payment_failed → mark as past_due
 */

import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createServiceClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'

const TIER_MAP: Record<string, string> = {
  starter: 'starter',
  professional: 'professional',
  enterprise: 'enterprise',
}

/**
 * Resolve the plan tier from the Stripe Price ID (server-authoritative) rather
 * than trusting client-supplied metadata.tier — otherwise a buyer who can
 * influence checkout metadata could self-assign 'enterprise'. Configure the
 * mapping via STRIPE_PRICE_STARTER / STRIPE_PRICE_PROFESSIONAL / STRIPE_PRICE_ENTERPRISE.
 * Falls back to the metadata tier when no price map is configured (back-compat).
 */
function resolveTier(priceId: string | undefined, metadataTier: string | undefined): string | undefined {
  const priceMap: Record<string, string> = {}
  if (process.env.STRIPE_PRICE_STARTER) priceMap[process.env.STRIPE_PRICE_STARTER] = 'starter'
  if (process.env.STRIPE_PRICE_PROFESSIONAL) priceMap[process.env.STRIPE_PRICE_PROFESSIONAL] = 'professional'
  if (process.env.STRIPE_PRICE_ENTERPRISE) priceMap[process.env.STRIPE_PRICE_ENTERPRISE] = 'enterprise'

  if (priceId && priceMap[priceId]) return priceMap[priceId]
  return metadataTier && TIER_MAP[metadataTier] ? TIER_MAP[metadataTier] : undefined
}

export async function POST(request: NextRequest) {
  const secretKey = process.env.STRIPE_SECRET_KEY
  const webhookSecret = process.env.STRIPE_BILLING_WEBHOOK_SECRET
  if (!secretKey || !webhookSecret) {
    return new NextResponse('Stripe billing not configured', { status: 500 })
  }

  const rawBody = await request.text()
  const signature = request.headers.get('stripe-signature') || ''
  if (!signature) {
    return new NextResponse('Missing Stripe-Signature', { status: 401 })
  }

  const stripe = new Stripe(secretKey)
  let event: Stripe.Event

  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown'
    logger.error('Stripe billing webhook signature verification failed', { err: message })
    return new NextResponse(`Invalid signature: ${message}`, { status: 401 })
  }

  const supabase = createServiceClient()

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session

        // Usage-billing card capture (agency ← practice). Store the saved card on billing_settings
        // and set it as the customer's default so off-session usage invoices can charge it.
        if (session.mode === 'setup' && session.metadata?.purpose === 'usage_billing_card') {
          const orgId = session.metadata.organization_id
          const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id
          const setupIntentId = typeof session.setup_intent === 'string' ? session.setup_intent : session.setup_intent?.id
          if (orgId && customerId) {
            let pmId: string | null = null
            if (setupIntentId) {
              const si = await stripe.setupIntents.retrieve(setupIntentId)
              pmId = typeof si.payment_method === 'string' ? si.payment_method : si.payment_method?.id ?? null
              if (pmId) {
                await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: pmId } })
              }
            }
            await supabase
              .from('billing_settings')
              .upsert(
                {
                  organization_id: orgId,
                  stripe_customer_id: customerId,
                  stripe_default_pm_id: pmId,
                  updated_at: new Date().toISOString(),
                },
                { onConflict: 'organization_id' },
              )
            logger.info('Usage-billing card stored', { orgId, customerId })
          }
          break
        }

        if (session.mode !== 'subscription') break

        const orgId = session.metadata?.organization_id
        const tier = session.metadata?.tier
        const subscriptionId = typeof session.subscription === 'string'
          ? session.subscription
          : session.subscription?.id

        if (orgId && tier && subscriptionId) {
          await supabase
            .from('organizations')
            .update({
              subscription_tier: TIER_MAP[tier] || tier,
              subscription_status: 'active',
              stripe_subscription_id: subscriptionId,
              trial_ends_at: null,
            })
            .eq('id', orgId)

          logger.info('Subscription activated via checkout', { orgId, tier, subscriptionId })
        }
        break
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription
        const orgId = sub.metadata?.organization_id

        if (!orgId) {
          // Try to find org by stripe_subscription_id
          const { data: org } = await supabase
            .from('organizations')
            .select('id')
            .eq('stripe_subscription_id', sub.id)
            .maybeSingle()
          if (!org) break

          await syncSubscriptionStatus(supabase, org.id, sub)
        } else {
          await syncSubscriptionStatus(supabase, orgId, sub)
        }
        break
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription
        const { data: org } = await supabase
          .from('organizations')
          .select('id')
          .eq('stripe_subscription_id', sub.id)
          .maybeSingle()

        if (org) {
          await supabase
            .from('organizations')
            .update({
              subscription_status: 'canceled',
              stripe_subscription_id: null,
            })
            .eq('id', org.id)

          logger.info('Subscription canceled', { orgId: org.id, subscriptionId: sub.id })
        }
        break
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice
        const customerId = typeof invoice.customer === 'string'
          ? invoice.customer
          : invoice.customer?.id

        if (customerId) {
          const { data: org } = await supabase
            .from('organizations')
            .select('id')
            .eq('stripe_customer_id', customerId)
            .maybeSingle()

          if (org) {
            await supabase
              .from('organizations')
              .update({ subscription_status: 'past_due' })
              .eq('id', org.id)

            logger.warn('Subscription payment failed', { orgId: org.id, invoiceId: invoice.id })
          }
        }
        break
      }

      case 'invoice.paid': {
        // Usage-invoice auto-charge settled → mark our local invoice paid (keyed on our metadata,
        // not organizations.* which is subject to schema drift).
        const invoice = event.data.object as Stripe.Invoice
        const usageInvoiceId = invoice.metadata?.usage_invoice_id
        if (invoice.metadata?.purpose === 'usage_invoice' && usageInvoiceId) {
          await supabase
            .from('usage_invoices')
            .update({
              status: 'paid',
              paid_at: new Date().toISOString(),
              hosted_invoice_url: invoice.hosted_invoice_url ?? undefined,
              updated_at: new Date().toISOString(),
            })
            .eq('id', usageInvoiceId)
          logger.info('Usage invoice paid', { usageInvoiceId })
        }
        break
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown'
    logger.error('Stripe billing webhook processing failed', { eventId: event.id, type: event.type, err: message })
    // Return non-2xx so Stripe RETRIES — a transient DB failure must not silently
    // drop a subscription state change (the signature was already verified).
    return new NextResponse('Processing failed', { status: 500 })
  }

  return NextResponse.json({ received: true })
}

async function syncSubscriptionStatus(
  supabase: ReturnType<typeof createServiceClient>,
  orgId: string,
  sub: Stripe.Subscription
) {
  // Tier from the Price ID (server-authoritative), not client metadata.
  const priceId = sub.items?.data?.[0]?.price?.id
  const tier = resolveTier(priceId, sub.metadata?.tier)
  const statusMap: Record<string, string> = {
    active: 'active',
    past_due: 'past_due',
    canceled: 'canceled',
    trialing: 'trialing',
    incomplete: 'past_due',
    incomplete_expired: 'canceled',
    paused: 'past_due',
    unpaid: 'past_due',
  }

  const updates: Record<string, unknown> = {
    subscription_status: statusMap[sub.status] || 'active',
    stripe_subscription_id: sub.id,
  }
  if (tier) {
    updates.subscription_tier = tier
  }

  await supabase
    .from('organizations')
    .update(updates)
    .eq('id', orgId)

  logger.info('Subscription status synced', { orgId, status: sub.status, tier })
}
