/**
 * POST /api/billing/checkout — Create a Stripe Checkout Session
 *
 * Creates a checkout session for the selected plan tier.
 * Redirects the user to Stripe's hosted checkout page.
 */

import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@/lib/supabase/server'

const PRICE_IDS: Record<string, string | undefined> = {
  starter: process.env.STRIPE_PRICE_STARTER,
  professional: process.env.STRIPE_PRICE_PROFESSIONAL,
  enterprise: process.env.STRIPE_PRICE_ENTERPRISE,
}

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

  const body = await request.json()
  const tier = body.tier as string

  if (!tier || !PRICE_IDS[tier]) {
    return NextResponse.json(
      { error: 'Invalid tier. Must be one of: starter, professional, enterprise' },
      { status: 400 }
    )
  }

  const priceId = PRICE_IDS[tier]
  if (!priceId) {
    return NextResponse.json(
      { error: `Stripe price not configured for tier: ${tier}. Set STRIPE_PRICE_${tier.toUpperCase()} env var.` },
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
    .eq('id', profile.organization_id)
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
    line_items: [{ price: priceId, quantity: 1 }],
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
