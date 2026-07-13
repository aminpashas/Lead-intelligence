import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { isCallGateEnabled, hasQualifyingCall } from '@/lib/booking/call-gate'
import { syncAppointmentToEhr } from '@/lib/booking/ehr-sync'
import { chargeNoShowFeeForAppointment, sendCardCaptureLink } from '@/lib/stripe/no-show-fee'
import { isAdminRole } from '@/lib/auth/permissions'
import { decryptField, decryptLeadPII } from '@/lib/encryption'
import { sendSMSToLead } from '@/lib/messaging/twilio'
import { processTriggerCampaigns } from '@/lib/campaigns/triggers'
import { seedPostConsultNurture } from '@/lib/campaigns/post-consult-nurture'
import { z } from 'zod'

// Pre-close statuses a consult attendee advances FROM. Leads already past this
// (treatment_presented / financing / converted / lost) are left as-is.
const PRE_CONSULT_STATUSES = [
  'new', 'contacted', 'qualified', 'consultation_scheduled', 'no_show', 'unresponsive', 'dormant',
]

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
  // No-show card-on-file: rep's per-booking choice to text the card link. Only
  // consulted in the optional mode (fee on, not required); ignored when the
  // practice requires a card (always sent) or the fee is off (never sent).
  // Defaults true so the link goes out unless the rep unchecks it.
  send_card_link: z.boolean().optional().default(true),
})

// GET /api/appointments
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { searchParams } = new URL(request.url)

  const { data: profile } = await getOwnProfile(supabase, 'id, organization_id')

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

  // Joined lead phone/email are encrypted at rest — decrypt before returning to the UI.
  const appointments = (data || []).map((appt) =>
    appt.lead ? { ...appt, lead: decryptLeadPII(appt.lead as Record<string, unknown>) } : appt
  )

  return NextResponse.json({ appointments })
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

  const { data: profile } = await getOwnProfile(supabase, 'id, organization_id, full_name')

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

  const { override_reason, send_card_link: sendCardLink, ...appointmentFields } = parsed.data
  const isConsultation = appointmentFields.type === 'consultation'

  // Load the practice's booking protocol config once (gate + no-show fee).
  const { data: bookingSettings } = await supabase
    .from('booking_settings')
    .select('require_call_before_booking, no_show_fee_enabled, no_show_fee_cents, card_on_file_required, timezone')
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

  // Mandatory card-on-file: the appointment is held as `pending_card` (not a
  // confirmed booking) until the Stripe webhook records the saved card. Only
  // meaningful when the no-show fee is enabled.
  const cardRequired = feeEnabled && bookingSettings?.card_on_file_required === true
  // Whether to text the card link now: always in required mode; in optional mode
  // only if the rep left the box checked.
  const shouldSendCardLink = feeEnabled && (cardRequired || sendCardLink !== false)

  const { data: appointment, error } = await supabase
    .from('appointments')
    .insert({
      ...appointmentFields,
      organization_id: orgId,
      assigned_to: appointmentFields.assigned_to || profile.id,
      booked_via: 'staff',
      status: cardRequired ? 'pending_card' : 'scheduled',
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
  let cardLinkSent = false
  if (shouldSendCardLink) {
    const { data: leadRow } = await supabase
      .from('leads')
      .select('phone_formatted')
      .eq('id', parsed.data.lead_id)
      .maybeSingle()
    const phone = leadRow?.phone_formatted ? (decryptField(leadRow.phone_formatted as string) || null) : null
    const { data: orgRow } = await supabase.from('organizations').select('name').eq('id', orgId).maybeSingle()
    cardLinkSent = await sendCardCaptureLink(supabase, orgId, {
      appointmentId: appointment.id,
      leadId: parsed.data.lead_id,
      feeCents: feeCents ?? 5000,
      phone,
      orgName: orgRow?.name || null,
    })
  }

  // Patient confirmation (net-new for staff bookings). Skip held/pending_card
  // slots — those aren't confirmed until the card link is completed.
  if (appointment.status === 'scheduled') {
    try {
      const { getBrandingForOrg } = await import('@/lib/branding/store')
      const { resolveBrandForContext } = await import('@/lib/branding/resolve-brand')
      const { renderVisitLogistics } = await import('@/lib/branding/visit-logistics')
      const { branding, orgName } = await getBrandingForOrg(supabase, orgId)

      const { data: confLead } = await supabase
        .from('leads')
        .select('first_name, phone_formatted, email, tags, custom_fields, utm_campaign, utm_source, campaign_attribution')
        .eq('id', parsed.data.lead_id)
        .maybeSingle()
      const phone = confLead?.phone_formatted ? (decryptField(confLead.phone_formatted as string) || null) : null
      const email = confLead?.email ? (decryptField(confLead.email as string) || null) : null
      const brand = resolveBrandForContext(branding, orgName, { lead: (confLead as never) ?? null })
      const logistics = renderVisitLogistics(brand)

      // Render the time in the practice's timezone (falls back to the default
      // practice tz) so the patient sees their local appointment time, not server UTC.
      const tz = (bookingSettings?.timezone as string | null) || 'America/Los_Angeles'
      const when = new Date(appointment.scheduled_at as string).toLocaleString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz,
      })
      const firstName = confLead?.first_name || 'there'

      if (phone) {
        // Consent-gated lead-facing send: sendSMSToLead enforces TCPA consent/DNC/opt-out
        // (and still funnels through the same MESSAGING_DRY_RUN choke point as sendSMS).
        await sendSMSToLead({
          supabase,
          leadId: parsed.data.lead_id,
          to: phone,
          body: `Hi ${firstName}! Your appointment at ${brand.practiceName} is confirmed for ${when}.${logistics.smsSuffix ? ` ${logistics.smsSuffix}` : ''} Reply STOP to opt out.`,
          caller: 'appointments.staff_booking_confirmation',
          actor: { id: profile.id, label: profile.full_name ?? null },
        })
      }

      // Rich confirmation email — the address/directions/"what to expect" the
      // patient needs to actually show up. Consent-gated like the SMS.
      if (email) {
        const { sendEmailToLead, transactionalFrom } = await import('@/lib/messaging/resend')
        const { escapeHtml } = await import('@/lib/utils')
        await sendEmailToLead({
          supabase,
          leadId: parsed.data.lead_id,
          from: transactionalFrom(),
          to: email,
          subject: `Appointment Confirmed — ${brand.practiceName}`,
          html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
          <h2 style="color: #111;">Your Appointment is Confirmed!</h2>
          <p>Hi ${escapeHtml(firstName)},</p>
          <p>You're all set for your appointment at <strong>${escapeHtml(brand.practiceName)}</strong>.</p>
          <div style="background: #f9f9f9; padding: 16px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 4px 0;"><strong>When:</strong> ${escapeHtml(when)}</p>
          </div>
          ${logistics.emailHtml}
          <p style="color: #666; font-size: 12px; margin-top: 24px;">
            Need to reschedule? Reply to this email or call us.
          </p>
        </div>
      `,
          text: `Hi ${firstName}, your appointment at ${brand.practiceName} is confirmed for ${when}.${logistics.emailText ? `\n\n${logistics.emailText}` : ''}\n\nWe look forward to seeing you!`,
          caller: 'appointments.staff_booking_confirmation',
        })
      }
    } catch (err) {
      await supabase.from('lead_activities').insert({
        organization_id: orgId,
        lead_id: parsed.data.lead_id,
        activity_type: 'notification_failed',
        title: 'Staff booking confirmation failed',
        metadata: { error: err instanceof Error ? err.message : 'unknown', channel: 'sms+email' },
      })
    }
  }

  // `held` tells the UI this slot isn't confirmed yet (waiting on the card);
  // `card_link_sent` drives the booking toast.
  return NextResponse.json(
    { appointment, card_link_sent: cardLinkSent, held: cardRequired },
    { status: 201 }
  )
}

// PATCH /api/appointments
export async function PATCH(request: NextRequest) {
  const supabase = await createClient()
  const { orgId, role } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await request.json()

  const { appointment_id, status, notes, card_override_reason } = body

  if (!appointment_id || !status) {
    return NextResponse.json({ error: 'appointment_id and status are required' }, { status: 400 })
  }

  // `pending_card` is a held slot, not a manually-settable status: only the
  // booking POST creates it and only the Stripe webhook (or the admin override
  // below) clears it. Reps therefore can't set it here.
  const validStatuses = ['scheduled', 'confirmed', 'completed', 'no_show', 'canceled', 'rescheduled']
  if (!validStatuses.includes(status)) {
    return NextResponse.json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` }, { status: 400 })
  }

  const { data: profile } = await getOwnProfile(supabase, 'id, organization_id')

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Guard the held slot: an appointment awaiting a card-on-file may only be
  // confirmed by an admin (the manual override — e.g. card read over the phone),
  // never by a rep flipping the status. Cancel/reschedule stay open so a held
  // slot can always be released. The webhook path never comes through here.
  const { data: current } = await supabase
    .from('appointments')
    .select('status, card_on_file')
    .eq('id', appointment_id)
    .eq('organization_id', orgId)
    .maybeSingle()

  let cardGateOverridden = false
  if (current?.status === 'pending_card' && current.card_on_file !== true) {
    const confirmingStatuses = ['scheduled', 'confirmed', 'completed']
    if (confirmingStatuses.includes(status)) {
      if (!isAdminRole(role ?? '')) {
        return NextResponse.json(
          {
            error: 'A card on file is required before this appointment can be confirmed. Resend the card link, or ask a manager to override.',
            code: 'card_required',
          },
          { status: 409 }
        )
      }
      cardGateOverridden = true
    }
  }

  const updateData: Record<string, unknown> = { status }
  if (notes !== undefined) updateData.notes = notes

  // Handle confirmation
  if (status === 'confirmed') {
    updateData.confirmation_received = true
    updateData.confirmed_via = 'manual'
    updateData.confirmed_at = new Date().toISOString()
    updateData.no_show_risk_score = 5
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
    .select('*, lead:leads(id, first_name, last_name, no_show_count, status)')
    .single()

  if (error || !appointment) {
    return NextResponse.json({ error: error?.message || 'Not found' }, { status: error ? 500 : 404 })
  }

  // EHR sync: propagate staff cancels / no-shows to the Dion Clinical bus (fire-and-forget).
  if (status === 'canceled' || status === 'no_show') {
    void syncAppointmentToEhr(supabase, appointment_id, {
      action: 'cancel',
      reasonCode: status === 'no_show' ? 'no-show' : 'patient-cancel',
    })
  }

  // If marking as no-show, increment the lead's no_show_count
  if (status === 'no_show' && appointment.lead) {
    const lead = appointment.lead as any
    await supabase
      .from('leads')
      .update({
        no_show_count: (lead.no_show_count || 0) + 1,
        status: 'no_show',
      })
      .eq('id', lead.id)
  }

  // Consult ATTENDED but not yet closed: advance the lead to consultation_completed,
  // stamp when the close window opened, and enroll them in the objection-aware
  // funding nurture (self-pay budgeting, co-signer financing, alternative lenders).
  // Only advances pre-close leads — anyone already presented/financing/converted is
  // left untouched. All non-fatal: a failure here never blocks the status update.
  if (status === 'completed' && (appointment as any).type === 'consultation' && appointment.lead) {
    const lead = appointment.lead as any
    if (PRE_CONSULT_STATUSES.includes(lead.status)) {
      try {
        await supabase
          .from('leads')
          .update({ status: 'consultation_completed', consult_completed_at: new Date().toISOString() })
          .eq('id', lead.id)
          .eq('organization_id', orgId)

        // Ensure the nurture campaign exists for this org (idempotent), then fire
        // the trigger that enrolls this lead.
        await seedPostConsultNurture(supabase, orgId)
        await processTriggerCampaigns(supabase, {
          event: 'consult_completed',
          lead_id: lead.id,
          organization_id: orgId,
        })

        await supabase.from('lead_activities').insert({
          organization_id: orgId,
          lead_id: lead.id,
          user_id: profile.id,
          activity_type: 'consult_completed',
          title: 'Consultation completed — enrolled in funding nurture',
          metadata: { appointment_id, from_status: lead.status },
        })
      } catch (err) {
        console.error('[appointments] consult_completed nurture enrollment failed:', err instanceof Error ? err.message : err)
      }
    }
  }

  // Log activity
  const lead = appointment.lead as any
  if (lead) {
    await supabase.from('lead_activities').insert({
      organization_id: orgId,
      lead_id: lead.id,
      user_id: profile.id,
      activity_type: cardGateOverridden ? 'appointment_confirmed_card_override' : `appointment_${status}`,
      title: cardGateOverridden
        ? 'Appointment confirmed without a card on file (manager override)'
        : `Appointment marked as ${status.replace('_', ' ')}`,
      description: cardGateOverridden ? (card_override_reason || null) : null,
      metadata: { appointment_id, status, card_gate_overridden: cardGateOverridden },
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

      // Atomically CLAIM the charge slot before touching Stripe. The gate above
      // reads a stale row, so two concurrent no_show PATCHes could both pass it and
      // both charge. This conditional UPDATE flips the status only if it is still
      // chargeable (Postgres serializes concurrent UPDATEs on the same row), so
      // exactly one request wins the claim; the loser gets no row back and skips.
      // (The Stripe idempotency key is the second line of defense.)
      const { data: claimed } = await supabase
        .from('appointments')
        .update({
          no_show_fee_status: 'charged',
          no_show_fee_cents: feeCents,
          no_show_fee_charged_at: new Date().toISOString(),
        })
        .eq('id', appt.id)
        .eq('organization_id', orgId)
        .in('no_show_fee_status', ['none', 'pending', 'failed'])
        .select('id')
        .maybeSingle()

      if (!claimed) {
        // Another request already charged (or the fee was waived) — do nothing.
        return NextResponse.json({ appointment })
      }

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
