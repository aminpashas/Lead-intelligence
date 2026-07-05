/**
 * POST /api/agency/billing-settings/reload — manually top up a practice's prepaid balance now.
 *
 * Agency-admin only, fires only on this explicit request. Charges the saved card for the practice's
 * configured reload amount (or an explicit `amountCents`) and credits the balance. No-ops with a
 * typed error when there's no card on file.
 */
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getOwnProfile } from '@/lib/auth/active-org'
import { chargeReload, getBalanceState } from '@/lib/billing/balance'

const bodySchema = z.object({
  organizationId: z.string().uuid(),
  amountCents: z.number().int().min(1).max(100_000_000).optional(),
})

const REASONS: Record<string, string> = {
  no_card_on_file: 'No card on file. Use “Set up card” first.',
  stripe_not_configured: 'Stripe is not configured.',
  zero_amount: 'Reload amount must be greater than $0.',
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()

  const { data: profile } = await getOwnProfile(supabase, 'role')
  if (!profile || profile.role !== 'agency_admin') {
    return NextResponse.json({ error: 'Forbidden — agency access required' }, { status: 403 })
  }

  let parsed
  try {
    parsed = bodySchema.parse(await request.json())
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const state = await getBalanceState(supabase, parsed.organizationId)
  const amount = parsed.amountCents ?? state.reloadAmountCents

  const result = await chargeReload(supabase, parsed.organizationId, amount)
  if (!result.ok) {
    return NextResponse.json({ error: REASONS[result.error] ?? `Reload failed: ${result.error}` }, { status: 422 })
  }

  return NextResponse.json({ ok: true, amountCents: result.amountCents, balanceCents: result.balanceCents })
}
