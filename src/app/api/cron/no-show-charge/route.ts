/**
 * Auto-no-show sweeper + no-show-fee charger.
 *
 * Two passes, scoped to orgs that opted into the no-show fee
 * (booking_settings.no_show_fee_enabled = true):
 *
 *   1. MARK — appointments still 'scheduled'/'confirmed' whose scheduled_at is
 *      past-due beyond NO_SHOW_GRACE_MINUTES are flipped to 'no_show' (mirroring
 *      the PATCH handler: stamps no_show_at, bumps leads.no_show_count + status,
 *      logs activity, fires the EHR cancel sync).
 *   2. CHARGE — appointments now in 'no_show' with a card on file and a fee still
 *      owed (no_show_fee_status IN none/pending/failed) are charged off-session
 *      via chargeNoShowFeeForAppointment(), which is idempotent per-appointment
 *      (Stripe idempotency key) and records the charge closed-loop
 *      (stripe_payments + events) for Meta CAPI / Google Ads / DGS.
 *
 * Never charges when no_show_fee_status = 'charged' (excluded by the query), so a
 * fee is charged at most once even across the PATCH path and this cron.
 *
 * Schedule: every 15 minutes (vercel.json). Guarded by CRON_SECRET via withCron.
 */
import { withCron } from '@/lib/cron/with-cron'
import { chargeNoShowFeeForAppointment } from '@/lib/stripe/no-show-fee'
import { syncAppointmentToEhr } from '@/lib/booking/ehr-sync'

export const dynamic = 'force-dynamic'

// Grace after scheduled_at before an unattended appointment is auto-no-showed.
const NO_SHOW_GRACE_MINUTES = 120
const MARK_BATCH = 100
const CHARGE_BATCH = 100

export const POST = withCron('no-show-charge', async ({ supabase }) => {
  // Orgs that opted into the no-show fee, with each org's default fee cents.
  const { data: settings } = await supabase
    .from('booking_settings')
    .select('organization_id, no_show_fee_cents')
    .eq('no_show_fee_enabled', true)

  const feeOrgs = new Map<string, number>()
  for (const s of settings ?? []) {
    feeOrgs.set(s.organization_id as string, (s.no_show_fee_cents as number) ?? 5000)
  }

  if (feeOrgs.size === 0) {
    return { status: 'skipped', items: 0, data: { marked: 0, charged: 0, failed: 0 } }
  }
  const orgIds = [...feeOrgs.keys()]

  const cutoff = new Date(Date.now() - NO_SHOW_GRACE_MINUTES * 60_000).toISOString()

  // ── 1. Auto-mark past-due unattended appointments as no_show ──
  const { data: dueRows } = await supabase
    .from('appointments')
    .select('id, organization_id, lead_id')
    .in('organization_id', orgIds)
    .in('status', ['scheduled', 'confirmed'])
    .lt('scheduled_at', cutoff)
    .limit(MARK_BATCH)

  let marked = 0
  for (const appt of dueRows ?? []) {
    // Guard the flip on the current status so a concurrent manual PATCH doesn't
    // get clobbered (and so we never double-bump no_show_count).
    const { data: updated, error: upErr } = await supabase
      .from('appointments')
      .update({
        status: 'no_show',
        no_show_at: new Date().toISOString(),
        no_show_risk_score: 100,
      })
      .eq('id', appt.id)
      .eq('organization_id', appt.organization_id)
      .in('status', ['scheduled', 'confirmed'])
      .select('id')
      .maybeSingle()

    if (upErr || !updated) continue
    marked++

    // Bump the lead's no_show_count + status (mirrors the PATCH handler).
    if (appt.lead_id) {
      const { data: leadRow } = await supabase
        .from('leads')
        .select('no_show_count')
        .eq('id', appt.lead_id)
        .maybeSingle()
      await supabase
        .from('leads')
        .update({
          no_show_count: ((leadRow?.no_show_count as number) ?? 0) + 1,
          status: 'no_show',
        })
        .eq('id', appt.lead_id)
        .eq('organization_id', appt.organization_id)
    }

    await supabase.from('lead_activities').insert({
      organization_id: appt.organization_id,
      lead_id: appt.lead_id,
      activity_type: 'appointment_no_show',
      title: 'Appointment auto-marked no-show (past-due, unattended)',
      metadata: { appointment_id: appt.id, auto: true, grace_minutes: NO_SHOW_GRACE_MINUTES },
    })

    // Propagate to the EHR bus (fire-and-forget; ehr-appointment-sync retries).
    void syncAppointmentToEhr(supabase, appt.id, { action: 'cancel', reasonCode: 'no-show' })
  }

  // ── 2. Charge card-on-file for no_show appointments still owed a fee ──
  const { data: chargeRows } = await supabase
    .from('appointments')
    .select(
      'id, organization_id, lead_id, stripe_customer_id, stripe_payment_method_id, no_show_fee_cents'
    )
    .in('organization_id', orgIds)
    .eq('status', 'no_show')
    .eq('card_on_file', true)
    // 'charged'/'waived' are intentionally excluded — never re-charge a settled fee.
    .in('no_show_fee_status', ['none', 'pending', 'failed'])
    .limit(CHARGE_BATCH)

  let charged = 0
  let failed = 0
  for (const appt of chargeRows ?? []) {
    const feeCents =
      (appt.no_show_fee_cents as number | null) ?? feeOrgs.get(appt.organization_id as string) ?? 5000

    const result = await chargeNoShowFeeForAppointment(supabase, appt.organization_id as string, {
      id: appt.id as string,
      lead_id: appt.lead_id as string | null,
      stripe_customer_id: appt.stripe_customer_id as string | null,
      stripe_payment_method_id: appt.stripe_payment_method_id as string | null,
      no_show_fee_cents: feeCents,
    })

    if (result.ok) {
      charged++
      await supabase
        .from('appointments')
        .update({
          no_show_fee_status: 'charged',
          no_show_fee_cents: feeCents,
          no_show_fee_charged_at: new Date().toISOString(),
          no_show_fee_payment_intent_id: result.paymentIntentId,
        })
        .eq('id', appt.id)
        .eq('organization_id', appt.organization_id)

      if (appt.lead_id) {
        await supabase.from('lead_activities').insert({
          organization_id: appt.organization_id,
          lead_id: appt.lead_id,
          activity_type: 'no_show_fee_charged',
          title: `No-show fee charged ($${Math.round(feeCents / 100)})`,
          metadata: {
            appointment_id: appt.id,
            payment_intent_id: result.paymentIntentId,
            fee_cents: feeCents,
            auto: true,
          },
        })
      }
    } else {
      failed++
      await supabase
        .from('appointments')
        .update({ no_show_fee_status: 'failed', no_show_fee_cents: feeCents })
        .eq('id', appt.id)
        .eq('organization_id', appt.organization_id)

      if (appt.lead_id) {
        await supabase.from('lead_activities').insert({
          organization_id: appt.organization_id,
          lead_id: appt.lead_id,
          activity_type: 'no_show_fee_failed',
          title: 'No-show fee charge failed — needs follow-up',
          description: result.error,
          metadata: { appointment_id: appt.id, error: result.error, auto: true },
        })
      }
    }
  }

  const items = marked + charged + failed
  return {
    status: items > 0 ? 'ok' : 'skipped',
    items,
    data: { marked, charged, failed },
  }
})

export const GET = POST
