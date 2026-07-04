/**
 * POST /api/agency/invoices/[id]/charge — charge a usage invoice now via Stripe.
 *
 * Agency-admin only, fires only on this explicit request. Delegates to chargeUsageInvoice, which
 * no-ops with a typed error when there's no card on file. Returns the hosted Stripe invoice URL.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOwnProfile } from '@/lib/auth/active-org'
import { chargeUsageInvoice } from '@/lib/billing/autocharge'

const REASONS: Record<string, string> = {
  no_card_on_file: 'No card on file for this practice. Use “Set up card” first.',
  already_charged: 'This invoice was already charged.',
  invoice_void: 'This invoice is void.',
  zero_total: 'Nothing to charge — the total is $0.',
  stripe_not_configured: 'Stripe is not configured.',
}

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  const { data: profile } = await getOwnProfile(supabase, 'role')
  if (!profile || profile.role !== 'agency_admin') {
    return NextResponse.json({ error: 'Forbidden — agency access required' }, { status: 403 })
  }

  const result = await chargeUsageInvoice(supabase, id)
  if (!result.ok) {
    return NextResponse.json({ error: REASONS[result.error] ?? `Charge failed: ${result.error}` }, { status: 422 })
  }

  return NextResponse.json({ ok: true, status: result.status, hostedUrl: result.hostedUrl })
}
