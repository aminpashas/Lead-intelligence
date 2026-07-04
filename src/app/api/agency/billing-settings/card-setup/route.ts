/**
 * POST /api/agency/billing-settings/card-setup — start card-on-file capture for a practice.
 *
 * Creates (or reuses) the practice's customer on the platform Stripe account and returns a hosted
 * Checkout session in `mode: 'setup'` (saves a card, charges nothing). On completion the
 * stripe-billing webhook stores stripe_customer_id + stripe_default_pm_id on billing_settings.
 * Agency-admin only. This is the activation prerequisite for autocharge.
 */
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getOwnProfile } from '@/lib/auth/active-org'
import { getStripeConfig, getStripeClient } from '@/lib/stripe/client'

const bodySchema = z.object({ organizationId: z.string().uuid() })

export async function POST(request: NextRequest) {
  const supabase = await createClient()

  const { data: profile } = await getOwnProfile(supabase, 'role')
  if (!profile || profile.role !== 'agency_admin') {
    return NextResponse.json({ error: 'Forbidden — agency access required' }, { status: 403 })
  }

  let organizationId: string
  try {
    organizationId = bodySchema.parse(await request.json()).organizationId
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '')
  if (!base) return NextResponse.json({ error: 'NEXT_PUBLIC_APP_URL not set' }, { status: 500 })

  const config = await getStripeConfig(supabase, organizationId)
  if (!config) return NextResponse.json({ error: 'Stripe not configured' }, { status: 500 })
  const stripe = getStripeClient(config)

  // Reuse the practice's platform customer if we already have one.
  const { data: bs } = await supabase
    .from('billing_settings')
    .select('stripe_customer_id')
    .eq('organization_id', organizationId)
    .maybeSingle()
  const { data: org } = await supabase.from('organizations').select('name, email').eq('id', organizationId).maybeSingle()

  let customerId = (bs?.stripe_customer_id as string | null) ?? null
  if (!customerId) {
    const customer = await stripe.customers.create({
      name: (org?.name as string) || undefined,
      email: (org?.email as string) || undefined,
      metadata: { organization_id: organizationId, purpose: 'usage_billing' },
    })
    customerId = customer.id
    await supabase
      .from('billing_settings')
      .upsert(
        { organization_id: organizationId, stripe_customer_id: customerId, updated_at: new Date().toISOString() },
        { onConflict: 'organization_id' },
      )
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'setup',
    customer: customerId,
    payment_method_types: ['card'],
    success_url: `${base}/agency/pricing?card=saved`,
    cancel_url: `${base}/agency/pricing?card=canceled`,
    metadata: { purpose: 'usage_billing_card', organization_id: organizationId },
  })

  return NextResponse.json({ ok: true, url: session.url })
}
