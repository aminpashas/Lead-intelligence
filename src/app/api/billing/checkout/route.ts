/**
 * POST /api/billing/checkout — Create a Stripe Checkout Session
 *
 * Creates a checkout session for the selected plan tier.
 * Redirects the user to Stripe's hosted checkout page.
 */

import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { isTierId, billableSeats, buildSubscriptionItems } from '@/lib/billing/tiers'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .single()

  if (!profile || !['owner', 'admin'].includes(profile.role)) {
    return NextResponse.json({ error: 'Only owners and admins can manage billing' }, { status: 403 })
  }

  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const tier = body.tier as string

  if (!tier || !isTierId(tier)) {
    return NextResponse.json(
      { error: 'Invalid tier. Must be one of: basic, growth, full' },
      { status: 400 }
    )
  }

  // Extra (billable) seats = staff beyond the tier's included allotment. The base fee covers the
  // included seats; each additional staff member adds a $50/mo licensed seat line.
  const { count: staffCount } = await supabase
    .from('user_profiles')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId)
  const extraSeats = billableSeats(tier, staffCount ?? 1)

  // Base (qty 1) + seat (qty = extraSeats) + 4 metered usage items. Throws — surfaced as 500 —
  // if any Stripe price is unconfigured, so we never sell a plan that silently drops usage billing.
  let lineItems: Array<{ price: string; quantity?: number }>
  try {
    lineItems = buildSubscriptionItems(tier, extraSeats)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Billing not configured' },
      { status: 500 }
    )
  }

  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) {
    return NextResponse.json({ error: 'Stripe not configured' }, { status: 500 })
  }

  const stripe = new Stripe(secretKey)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001'

  // Get org info for Stripe metadata
  const { data: org } = await supabase
    .from('organizations')
    .select('id, name, email, stripe_customer_id')
    .eq('id', orgId)
    .single()

  if (!org) {
    return NextResponse.json({ error: 'Organization not found' }, { status: 404 })
  }

  // Reuse existing Stripe customer or create a new one
  let customerId = org.stripe_customer_id
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: org.email || user.email || undefined,
      name: org.name,
      metadata: {
        organization_id: org.id,
        created_by: user.id,
      },
    })
    customerId = customer.id

    // Persist the customer ID
    await supabase
      .from('organizations')
      .update({ stripe_customer_id: customerId })
      .eq('id', org.id)
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: lineItems,
    success_url: `${appUrl}/billing?session_id={CHECKOUT_SESSION_ID}&success=true`,
    cancel_url: `${appUrl}/billing?canceled=true`,
    subscription_data: {
      metadata: {
        organization_id: org.id,
        tier,
      },
    },
    metadata: {
      organization_id: org.id,
      tier,
    },
  })

  return NextResponse.json({ url: session.url })
}
