import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { createCardCaptureSession } from '@/lib/stripe/no-show-fee'
import { decryptField } from '@/lib/encryption'

/**
 * POST /api/appointments/[id]/card-setup
 *
 * Generate a fresh Stripe card-on-file (SetupIntent) Checkout link for an
 * appointment's no-show fee — used by staff to resend the link or capture a card
 * for a manually-booked consultation. Returns the hosted URL to share.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: appt } = await supabase
    .from('appointments')
    .select('id, lead_id, no_show_fee_cents')
    .eq('id', id)
    .eq('organization_id', orgId)
    .maybeSingle()
  if (!appt) return NextResponse.json({ error: 'Appointment not found' }, { status: 404 })

  const { data: settings } = await supabase
    .from('booking_settings')
    .select('no_show_fee_enabled, no_show_fee_cents')
    .eq('organization_id', orgId)
    .maybeSingle()

  if (!settings?.no_show_fee_enabled) {
    return NextResponse.json({ error: 'No-show fee is not enabled for this practice.' }, { status: 400 })
  }

  const feeCents = appt.no_show_fee_cents ?? settings.no_show_fee_cents ?? 5000

  const { data: leadRow } = await supabase
    .from('leads')
    .select('email, first_name, last_name')
    .eq('id', appt.lead_id)
    .maybeSingle()

  const email = leadRow?.email ? (decryptField(leadRow.email as string) || null) : null
  const first = leadRow?.first_name ? (decryptField(leadRow.first_name as string) || '') : ''
  const last = leadRow?.last_name ? (decryptField(leadRow.last_name as string) || '') : ''
  const name = `${first} ${last}`.trim() || null

  const session = await createCardCaptureSession(supabase, orgId, {
    appointmentId: appt.id,
    leadId: appt.lead_id,
    feeCents,
    email,
    name,
  })

  if (!session) {
    return NextResponse.json({ error: 'Stripe is not configured or app URL is missing.' }, { status: 502 })
  }

  return NextResponse.json({ url: session.url, fee_cents: feeCents })
}
