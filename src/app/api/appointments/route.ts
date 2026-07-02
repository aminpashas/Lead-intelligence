import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { isCallGateEnabled, hasQualifyingCall } from '@/lib/booking/call-gate'
import { chargeNoShowFeeForAppointment, sendCardCaptureLink } from '@/lib/stripe/no-show-fee'
import { moveLeadStageForAppointmentEvent } from '@/lib/pipeline/stage-mover'
import { calculateNoShowRisk } from '@/lib/campaigns/reminders'
import { decryptField } from '@/lib/encryption'
import { z } from 'zod'

const createAppointmentSchema = z.object({
  lead_id: z.string().uuid(),
  type: z.enum(['consultation', 'follow_up', 'treatment', 'scan', 'other']),
  scheduled_at: z.string(), // ISO datetime
  duration_minutes: z.number().min(15).max(480).optional().default(60),
  location: z.string().optional(),
  notes: z.string().optional(),
  assigned_to: z.string().uuid().optional(),
  // Phone-first soft gate: staff may book without a logged call by supplying a
  // reason, which is recorded as an override on the appointment.
  override_reason: z.string().min(1).max(500).optional(),
})

// GET /api/appointments
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { searchParams } = new URL(request.url)

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let query = supabase
    .from('appointments')
    .select('*, lead:leads(id, first_name, last_name, phone, email)')
    .eq('organization_id', orgId)
    .order('scheduled_at', { ascending: true })

  const status = searchParams.get('status')
  if (status) query = query.eq('status', status)

  const from = searchParams.get('from')
  if (from) query = query.gte('scheduled_at', from)

  const to = searchParams.get('to')
  if (to) query = query.lte('scheduled_at', to)

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ appointments: data })
}

// POST /api/appointments
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await request.json()
  const parsed = createAppointmentSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 })
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Defend against BOLA - assert lead belongs to this organization
  const { data: verifiedLead, error: leadError } = await supabase
    .from('leads')
    .select('id')
    .eq('id', parsed.data.lead_id)
    .eq('organization_id', orgId)
    .single()

  if (leadError || !verifiedLead) {
    return NextResponse.json({ error: 'Lead not found or unauthorized' }, { status: 404 })
  }

  const { override_reason, ...appointmentFields } = parsed.data
  const isConsultation = appointmentFields.type === 'consultation'

  // Load the practice's booking protocol config once (gate + no-show fee).
  const { data: bookingSettings } = await supabase
    .from('booking_settings')
    .select('require_call_before_booking, no_show_fee_enabled, no_show_fee_cents')
    .eq('organization_id', orgId)
    .maybeSingle()

  // Phone-first soft gate: if the practice requires a call before booking a
  // consultation and none is logged, block UNLESS staff supplied an override
  // reason (recorded for audit). follow_up/treatment/etc. are not gated.
  let gateOverridden = false
  if (isConsultation && isCallGateEnabled(bookingSettings)) {
    const talked = await hasQualifyingCall(supabase, orgId, appointmentFields.lead_id)
    if (!talked) {
      if (!override_reason) {
        return NextResponse.json(
          {
            error: 'A phone call must be logged before booking a consultation.',
            code: 'call_required',
          },
          { status: 409 }
        )
      }
      gateOverridden = true
    }
  }

  const feeEnabled = isConsultation && bookingSettings?.no_show_fee_enabled === true
  const feeCents = feeEnabled ? (bookingSettings?.no_show_fee_cents ?? 5000) : null

  const { data: appointment, error } = await supabase
    .from('appointments')
    .insert({
      ...appointmentFields,
      organization_id: orgId,
      assigned_to: appointmentFields.assigned_to || profile.id,
      booked_via: 'staff',
      call_gate_overridden: gateOverridden,
      override_reason: gateOverridden ? override_reason : null,
      override_by: gateOverridden ? profile.id : null,
      no_show_fee_cents: feeCents,
    })
    .select('*, lead:leads(id, first_name, last_name)')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Update lead status
  await supabase
    .from('leads')
    .update({
      status: 'consultation_scheduled',
      consultation_date: parsed.data.scheduled_at,
      consultation_type: parsed.data.type === 'consultation' ? 'in_person' : undefined,
    })
    .eq('id', parsed.data.lead_id)

  // Kanban: hard-move the card to the consult stage (non-blocking).
  void moveLeadStageForAppointmentEvent(supabase, {
    orgId,
    leadId: parsed.data.lead_id,
    event: 'booked',
  })

  // Log activity
  await supabase.from('lead_activities').insert({
    organization_id: orgId,
    lead_id: parsed.data.lead_id,
    user_id: profile.id,
    activity_type: gateOverridden ? 'appointment_scheduled_gate_override' : 'appointment_scheduled',
    title: gateOverridden
      ? `${parsed.data.type} booked without a logged call (override)`
      : `${parsed.data.type} scheduled for ${new Date(parsed.data.scheduled_at).toLocaleDateString()}`,
    description: gateOverridden ? override_reason : null,
    metadata: { appointment_id: appointment.id, type: parsed.data.type, gate_overridden: gateOverridden },
  })

  // No-show fee: text the patient a card-on-file link (charged only on no-show).
  if (feeEnabled) {
    const { data: leadRow } = await supabase
      .from('leads')
      .select('phone_formatted')
      .eq('id', parsed.data.lead_id)
      .maybeSingle()
    const phone = leadRow?.phone_formatted ? (decryptField(leadRow.phone_formatted as string) || null) : null
    const { data: orgRow } = await supabase.from('organizations').select('name').eq('id', orgId).maybeSingle()
    await sendCardCaptureLink(supabase, orgId, {
      appointmentId: appointment.id,
      leadId: parsed.data.lead_id,
      feeCents: feeCents ?? 5000,
      phone,
      orgName: orgRow?.name || null,
    })
  }

  return NextResponse.json({ appointment }, { status: 201 })
}

// PATCH /api/appointments
export async function PATCH(request: NextRequest) {
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await request.json()

  const { appointment_id, status, notes } = body

  if (!appointment_id || !status) {
    return NextResponse.json({ error: 'appointment_id and status are required' }, { status: 400 })
  }

  const validStatuses = ['scheduled', 'confirmed', 'completed', 'no_show', 'canceled', 'rescheduled']
  if (!validStatuses.includes(status)) {
    return NextResponse.json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` }, { status: 400 })
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const updateData: Record<string, unknown> = { status }
  if (notes !== undefined) updateData.notes = notes

  // Handle confirmation
  if (status === 'confirmed') {
    updateData.confirmation_received = true
    updateData.confirmed_via = 'manual'
    updateData.confirmed_at = new Date().toISOString()
  }

  // Handle no-show
  if (status === 'no_show') {
    updateData.no_show_risk_score = 100
  }

  const { data: appointment, error } = await supabase
    .from('appointments')
    .update(updateData)
    .eq('id', appointment_id)
    .eq('organization_id', orgId)
    .select('*, lead:leads(id, first_name, last_name, no_show_count)')
    .single()

  if (error || !appointment) {
    return NextResponse.json({ error: error?.message || 'Not found' }, { status: error ? 500 : 404 })
  }

  // Confirmation lowers risk but no longer erases history (serial no-showers stay visible).
  if (status === 'confirmed') {
    await calculateNoShowRisk(supabase, appointment_id)
  }

  const lead = appointment.lead as any

  // If marking as no-show, increment the lead's no_show_count
  if (status === 'no_show' && lead) {
    await supabase
      .from('leads')
      .update({
        no_show_count: (lead.no_show_count || 0) + 1,
        status: 'no_show',
      })
      .eq('id', lead.id)
  }

  // Kanban: hard-move the card on cancel/no-show (non-blocking).
  if ((status === 'canceled' || status === 'no_show') && lead) {
    void moveLeadStageForAppointmentEvent(supabase, {
      orgId,
      leadId: lead.id,
      event: status === 'no_show' ? 'no_show' : 'canceled',
    })
  }

  // Log activity
  if (lead) {
    await supabase.from('lead_activities').insert({
      organization_id: orgId,
      lead_id: lead.id,
      user_id: profile.id,
      activity_type: `appointment_${status}`,
      title: `Appointment marked as ${status.replace('_', ' ')}`,
      metadata: { appointment_id, status },
    })
  }

  // Auto-charge the $50 no-show fee off-session. Idempotent: only fires when the
  // practice enabled the fee, a card is on file, and it hasn't been charged yet.
  const appt = appointment as any
  if (
    status === 'no_show' &&
    appt.card_on_file === true &&
    appt.no_show_fee_status !== 'charged'
  ) {
    const { data: feeSettings } = await supabase
      .from('booking_settings')
      .select('no_show_fee_enabled, no_show_fee_cents')
      .eq('organization_id', orgId)
      .maybeSingle()

    if (feeSettings?.no_show_fee_enabled) {
      const feeCents = appt.no_show_fee_cents ?? feeSettings.no_show_fee_cents ?? 5000
      const result = await chargeNoShowFeeForAppointment(supabase, orgId, {
        id: appt.id,
        stripe_customer_id: appt.stripe_customer_id,
        stripe_payment_method_id: appt.stripe_payment_method_id,
        no_show_fee_cents: feeCents,
      })

      if (result.ok) {
        await supabase
          .from('appointments')
          .update({
            no_show_fee_status: 'charged',
            no_show_fee_cents: feeCents,
            no_show_fee_charged_at: new Date().toISOString(),
            no_show_fee_payment_intent_id: result.paymentIntentId,
          })
          .eq('id', appt.id)
          .eq('organization_id', orgId)

        if (lead) {
          await supabase.from('lead_activities').insert({
            organization_id: orgId,
            lead_id: lead.id,
            user_id: profile.id,
            activity_type: 'no_show_fee_charged',
            title: `No-show fee charged ($${Math.round(feeCents / 100)})`,
            metadata: { appointment_id, payment_intent_id: result.paymentIntentId, fee_cents: feeCents },
          })
        }
      } else {
        await supabase
          .from('appointments')
          .update({ no_show_fee_status: 'failed', no_show_fee_cents: feeCents })
          .eq('id', appt.id)
          .eq('organization_id', orgId)

        if (lead) {
          await supabase.from('lead_activities').insert({
            organization_id: orgId,
            lead_id: lead.id,
            user_id: profile.id,
            activity_type: 'no_show_fee_failed',
            title: 'No-show fee charge failed — needs follow-up',
            description: result.error,
            metadata: { appointment_id, error: result.error },
          })
        }
      }
    }
  }

  return NextResponse.json({ appointment })
}
