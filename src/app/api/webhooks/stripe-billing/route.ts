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
import { TIER_PRICE_ENV, TIERS, isTierId, type TierId } from '@/lib/billing/tiers'

// Tiers the webhook will accept from metadata: the sellable ladder plus legacy tiers still live
// on existing subscriptions. Identity map — validation, not translation.
const TIER_MAP: Record<string, string> = {
  basic: 'basic',
  growth: 'growth',
  full: 'full',
  starter: 'starter',
  professional: 'professional',
  enterprise: 'enterprise',
}

/**
 * Build the Stripe-Price-ID → tier map from the environment. Sellable tiers are configured via
 * TIER_PRICE_ENV (STRIPE_PRICE_BASIC/GROWTH/FULL); legacy price envs are kept so old subscriptions
 * still resolve. A subscription now carries several line items (base + seat + metered), so callers
 * search ALL item price IDs for the one that matches a known base price.
 */
function tierPriceMap(): Record<string, string> {
  const map: Record<string, string> = {}
  for (const id of Object.keys(TIER_PRICE_ENV) as TierId[]) {
    const priceId = process.env[TIER_PRICE_ENV[id]]
    if (priceId) map[priceId] = id
  }
  if (process.env.STRIPE_PRICE_STARTER) map[process.env.STRIPE_PRICE_STARTER] = 'starter'
  if (process.env.STRIPE_PRICE_PROFESSIONAL) map[process.env.STRIPE_PRICE_PROFESSIONAL] = 'professional'
  if (process.env.STRIPE_PRICE_ENTERPRISE) map[process.env.STRIPE_PRICE_ENTERPRISE] = 'enterprise'
  return map
}

/**
 * Resolve the plan tier from a subscription's Price IDs (server-authoritative) rather than trusting
 * client-supplied metadata.tier — otherwise a buyer who can influence checkout metadata could
 * self-assign a higher tier. Falls back to validated metadata when no price map matches (back-compat).
 */
function resolveTier(priceIds: (string | undefined)[], metadataTier: string | undefined): string | undefined {
  const priceMap = tierPriceMap()
  for (const priceId of priceIds) {
    if (priceId && priceMap[priceId]) return priceMap[priceId]
  }
  return metadataTier && TIER_MAP[metadataTier] ? TIER_MAP[metadataTier] : undefined
}

/**
 * Keep the internal usage-invoice engine (billing_settings.platform_fee_cents) in step with the
 * tier the customer bought, so agency dashboards and internal invoices show the same platform fee
 * Stripe charges. Best-effort: a failure here must not fail the webhook (Stripe is the biller).
 */
async function syncPlatformFee(
  supabase: ReturnType<typeof createServiceClient>,
  orgId: string,
  tier: string,
): Promise<void> {
  if (!isTierId(tier)) return
  try {
    await supabase
      .from('billing_settings')
      .upsert(
        { organization_id: orgId, platform_fee_cents: TIERS[tier].baseFeeCents, updated_at: new Date().toISOString() },
        { onConflict: 'organization_id' },
      )
  } catch (err) {
    logger.warn('Failed to sync platform fee to billing_settings', { orgId, tier, err: err instanceof Error ? err.message : 'Unknown' })
  }
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
        if (session.mode !== 'subscription') break

        const orgId = session.metadata?.organization_id
        const tier = session.metadata?.tier
        const subscriptionId = typeof session.subscription === 'string'
          ? session.subscription
          : session.subscription?.id

        if (orgId && tier && subscriptionId) {
          const resolvedTier = TIER_MAP[tier] || tier
          await supabase
            .from('organizations')
            .update({
              subscription_tier: resolvedTier,
              subscription_status: 'active',
              stripe_subscription_id: subscriptionId,
              trial_ends_at: null,
            })
            .eq('id', orgId)
          await syncPlatformFee(supabase, orgId, resolvedTier)

          logger.info('Subscription activated via checkout', { orgId, tier: resolvedTier, subscriptionId })
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
  // Tier from the subscription's Price IDs (server-authoritative), not client metadata. The base
  // (tier) price is one of several line items — search them all for the one we recognize.
  const priceIds = (sub.items?.data ?? []).map((i) => i.price?.id)
  const tier = resolveTier(priceIds, sub.metadata?.tier)
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

  if (tier) await syncPlatformFee(supabase, orgId, tier)

  logger.info('Subscription status synced', { orgId, status: sub.status, tier })
}
