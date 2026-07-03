/**
 * EHR appointment sync seam.
 *
 * The single place a booking create/cancel fans out to the outside world. Called
 * fire-and-forget from every write-site (public booking route, AI booking tool,
 * appointment status endpoint). It NEVER throws and NEVER blocks the booking —
 * a federation / CareStack / Slack failure must not stop a confirmed consult.
 *
 * Legs (independent — one failing doesn't skip the others):
 *   1. Dion Clinical — emit appointment.booked / appointment.cancelled to the EMR bus.
 *   2. CareStack     — create / cancel the appointment in the PMS (gated by config).
 *   3. Slack / connectors — on `book`, dispatch consultation.scheduled (staff notify).
 *
 * Per-leg status is stored on the appointment row; the ehr-appointment-sync cron
 * re-drives any leg left 'pending'/'failed'.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { emitAppointmentBooked, emitAppointmentCancelled, type DionEmitResult } from '@/lib/bridges/dion-clinical'
import { dispatchConnectorEvent, buildConnectorLeadData } from '@/lib/connectors'
import { getCareStackConfig } from '@/lib/ehr/carestack/client'
import { pushAppointmentToCareStack, cancelAppointmentInCareStack } from '@/lib/ehr/carestack/appointments'
import type { EhrSyncStatus } from '@/types/database'

export type EhrSyncAction = 'book' | 'cancel'

export type EhrSyncOptions = {
  action: EhrSyncAction
  /** For cancels: a non-PHI coded reason, e.g. "no-show", "patient-cancel". */
  reasonCode?: string
}

type AppointmentRow = {
  id: string
  organization_id: string
  lead_id: string
  scheduled_at: string
  duration_minutes: number | null
  ehr_sync_attempts: number | null
  carestack_appointment_id: string | null
}

type LegResult = { status: EhrSyncStatus; error?: string }
type CareStackLegResult = LegResult & { carestackAppointmentId?: string }

function dionStatus(result: DionEmitResult): EhrSyncStatus {
  if (result.skipped) return 'skipped'
  return result.ok ? 'synced' : 'failed'
}

async function runCareStackLeg(
  supabase: SupabaseClient,
  appt: AppointmentRow,
  lead: Record<string, unknown> | null,
  opts: EhrSyncOptions,
): Promise<CareStackLegResult> {
  const config = await getCareStackConfig(supabase, appt.organization_id)
  if (!config) return { status: 'skipped' }

  try {
    if (opts.action === 'book') {
      // Idempotent: if we already created it (e.g. a retry where only the Dion leg
      // failed), don't create a second CareStack appointment.
      if (appt.carestack_appointment_id) {
        return { status: 'synced', carestackAppointmentId: appt.carestack_appointment_id }
      }
      if (!lead) return { status: 'failed', error: 'lead not found for CareStack patient' }
      const { data: settings } = await supabase
        .from('booking_settings')
        .select('carestack_location_id, carestack_provider_id, carestack_operatory_id, carestack_appointment_type')
        .eq('organization_id', appt.organization_id)
        .maybeSingle()
      const carestackAppointmentId = await pushAppointmentToCareStack(supabase, config, {
        appointment: appt,
        lead,
        settings: settings ?? {},
      })
      return { status: 'synced', carestackAppointmentId }
    }
    // cancel — only meaningful if we actually created it in CareStack
    if (appt.carestack_appointment_id) {
      await cancelAppointmentInCareStack(config, appt.carestack_appointment_id)
    }
    return { status: 'synced' }
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : 'carestack error' }
  }
}

export async function syncAppointmentToEhr(
  supabase: SupabaseClient,
  appointmentId: string,
  opts: EhrSyncOptions,
): Promise<void> {
  try {
    const { data: appt } = await supabase
      .from('appointments')
      .select('id, organization_id, lead_id, scheduled_at, duration_minutes, ehr_sync_attempts, carestack_appointment_id')
      .eq('id', appointmentId)
      .single()
    if (!appt) return
    const appointment = appt as AppointmentRow

    const { data: org } = await supabase
      .from('organizations')
      .select('dion_practice_id')
      .eq('id', appointment.organization_id)
      .single()
    const dionPracticeId: string | null = org?.dion_practice_id ?? null

    // Lead is only needed on `book` (Slack card + CareStack patient resolution).
    let lead: Record<string, unknown> | null = null
    if (opts.action === 'book') {
      const { data } = await supabase.from('leads').select('*').eq('id', appointment.lead_id).single()
      lead = data ?? null
    }

    // ── Leg 1: Dion Clinical ──────────────────────────────────────────────
    const dionResult =
      opts.action === 'book'
        ? await emitAppointmentBooked({ appointmentId: appointment.id, startsAt: appointment.scheduled_at, dionPracticeId })
        : await emitAppointmentCancelled({ appointmentId: appointment.id, reasonCode: opts.reasonCode, dionPracticeId })

    // ── Leg 2: CareStack ──────────────────────────────────────────────────
    const cs = await runCareStackLeg(supabase, appointment, lead, opts)

    // Single combined row update.
    const dion_sync_status = dionStatus(dionResult)
    const errorParts = [dionResult.ok ? null : dionResult.error, cs.status === 'failed' ? cs.error : null].filter(Boolean)
    const update: Record<string, unknown> = {
      dion_sync_status,
      carestack_sync_status: cs.status,
      ehr_sync_attempts: (appointment.ehr_sync_attempts ?? 0) + 1,
      ehr_sync_error: errorParts.length ? errorParts.join(' | ') : null,
    }
    if (cs.carestackAppointmentId) update.carestack_appointment_id = cs.carestackAppointmentId
    await supabase.from('appointments').update(update).eq('id', appointment.id)

    // Failure activity log per failed leg (best-effort, non-blocking).
    const failures: Array<{ leg: string; error?: string }> = []
    if (!dionResult.ok && !dionResult.skipped) failures.push({ leg: 'dion', error: dionResult.error })
    if (cs.status === 'failed') failures.push({ leg: 'carestack', error: cs.error })
    for (const f of failures) {
      await supabase.from('lead_activities').insert({
        organization_id: appointment.organization_id,
        lead_id: appointment.lead_id,
        activity_type: 'ehr_sync_failed',
        title: `${f.leg} ${opts.action} sync failed`,
        metadata: { appointment_id: appointment.id, leg: f.leg, error: f.error ?? 'unknown' },
      })
    }

    // ── Leg 3: Slack / connectors (staff notification on booking) ─────────
    if (opts.action === 'book' && lead) {
      dispatchConnectorEvent(supabase, {
        type: 'consultation.scheduled',
        organizationId: appointment.organization_id,
        leadId: appointment.lead_id,
        timestamp: new Date().toISOString(),
        data: {
          lead: buildConnectorLeadData(lead),
          metadata: { appointment_id: appointment.id, scheduled_at: appointment.scheduled_at },
        },
      }).catch(() => {
        /* connector dispatch is non-blocking; per-connector errors are logged internally */
      })
    }
  } catch {
    // The seam is fire-and-forget: never throw back into the booking flow.
  }
}
