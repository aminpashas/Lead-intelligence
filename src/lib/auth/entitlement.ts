/**
 * Subscription entitlement gate.
 *
 * Billing state (organizations.subscription_status) was previously only read for
 * display — a `past_due` / `canceled` org kept full access to paid actions
 * (SMS/email/voice sends, autopilot). This helper blocks cost-incurring actions
 * unless the subscription is active or trialing.
 *
 * Deliberately fail-OPEN on a read error: a transient DB hiccup must not take
 * down a paying customer's sends. Only a definitively non-active status blocks.
 */

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

const ACTIVE_STATUSES = new Set(['active', 'trialing'])

/**
 * Returns a 402 NextResponse if the org's subscription is not active/trialing,
 * otherwise null (allowed).
 */
export async function assertActiveSubscription(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<NextResponse | null> {
  const { data: org } = await supabase
    .from('organizations')
    .select('subscription_status')
    .eq('id', organizationId)
    .single()

  if (org?.subscription_status && !ACTIVE_STATUSES.has(org.subscription_status)) {
    return NextResponse.json(
      { error: 'Subscription inactive — please update billing to continue', subscription_status: org.subscription_status },
      { status: 402 },
    )
  }
  return null
}
