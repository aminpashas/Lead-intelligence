import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { sendCardCaptureLink } from '@/lib/stripe/no-show-fee'
import { decryptField } from '@/lib/encryption'

/**
 * POST /api/leads/[id]/card-on-file
 *
 * Team-triggered send/resend of the no-show card-on-file link for a lead. The
 * card is appointment-scoped (that's how the saved card matches the later
 * no-show charge), so this resolves the lead's active upcoming appointment and
 * texts the link for it. If there's no appointment yet, it returns 409 so the UI
 * can tell the rep to book first.
 *
 * Gated on the practice's no_show_fee_enabled, matching the disclosure text and
 * the charge engine (both need the fee configured).
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: leadId } = await params
  const supabase = await createClient()

  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // BOLA guard + fetch the lead's contact fields in one shot.
  const { data: lead } = await supabase
    .from('leads')
    .select('id, phone_formatted, email, first_name, last_name')
    .eq('id', leadId)
    .eq('organization_id', orgId)
    .maybeSingle()
  if (!lead) return NextResponse.json({ error: 'Lead not found' }, { status: 404 })

  const { data: settings } = await supabase
    .from('booking_settings')
    .select('no_show_fee_enabled, no_show_fee_cents')
    .eq('organization_id', orgId)
    .maybeSingle()

  if (!settings?.no_show_fee_enabled) {
    return NextResponse.json({ error: 'No-show fee is not enabled for this practice.' }, { status: 400 })
  }

  // The active appointment to attach the card to: soonest upcoming slot that is
  // still live (not canceled/completed/no_show). A held `pending_card` slot is
  // exactly the resend case, so it's included.
  const nowIso = new Date().toISOString()
  const { data: appt } = await supabase
    .from('appointments')
    .select('id, no_show_fee_cents')
    .eq('lead_id', leadId)
    .eq('organization_id', orgId)
    .in('status', ['scheduled', 'confirmed', 'pending_card', 'rescheduled'])
    .gte('scheduled_at', nowIso)
    .order('scheduled_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!appt) {
    return NextResponse.json(
      { error: 'No upcoming appointment to attach a card to. Book the appointment first.', code: 'no_upcoming_appointment' },
      { status: 409 }
    )
  }

  const phone = lead.phone_formatted ? (decryptField(lead.phone_formatted as string) || null) : null
  const email = lead.email ? (decryptField(lead.email as string) || null) : null
  const first = lead.first_name ? (decryptField(lead.first_name as string) || '') : ''
  const last = lead.last_name ? (decryptField(lead.last_name as string) || '') : ''
  const name = `${first} ${last}`.trim() || null

  if (!phone) {
    return NextResponse.json({ error: 'This lead has no phone number to text the link to.' }, { status: 400 })
  }

  const { data: orgRow } = await supabase.from('organizations').select('name').eq('id', orgId).maybeSingle()
  const feeCents = appt.no_show_fee_cents ?? settings.no_show_fee_cents ?? 5000

  const sent = await sendCardCaptureLink(supabase, orgId, {
    appointmentId: appt.id,
    leadId,
    feeCents,
    phone,
    email,
    name,
    orgName: orgRow?.name || null,
  })

  if (!sent) {
    return NextResponse.json({ error: 'Could not send the card link (check messaging consent and Stripe setup).' }, { status: 502 })
  }

  return NextResponse.json({ sent: true, appointment_id: appt.id, fee_cents: feeCents })
}
