/**
 * EHR appointment sync seam.
 *
 * The single place a booking create/cancel fans out to the outside world. Called
 * fire-and-forget from every write-site (public booking route, AI booking tool,
 * appointment status endpoint). It NEVER throws and NEVER blocks the booking —
 * a federation or Slack failure must not stop a confirmed consult.
 *
 * Legs:
 *   1. Dion Clinical — emit appointment.booked / appointment.cancelled to the EMR bus.
 *   2. Slack / connectors — on `book`, dispatch consultation.scheduled (staff notify).
 *   3. CareStack write — ADDED IN PHASE 4 (leaves carestack_sync_status = 'pending').
 *
 * Per-leg status is stored on the appointment row; the ehr-appointment-sync cron
 * re-drives any Dion leg left 'pending'/'failed'.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { emitAppointmentBooked, emitAppointmentCancelled, type DionEmitResult } from '@/lib/bridges/dion-clinical'
import { dispatchConnectorEvent, buildConnectorLeadData } from '@/lib/connectors'
import type { EhrSyncStatus } from '@/types/database'

export type EhrSyncAction = 'book' | 'cancel'

export type EhrSyncOptions = {
  action: EhrSyncAction
  /** For cancels: a non-PHI coded reason, e.g. "no-show", "patient-cancel". */
  reasonCode?: string
}

function statusFrom(result: DionEmitResult): EhrSyncStatus {
  if (result.skipped) return 'skipped'
  return result.ok ? 'synced' : 'failed'
}

export async function syncAppointmentToEhr(
  supabase: SupabaseClient,
  appointmentId: string,
  opts: EhrSyncOptions,
): Promise<void> {
  try {
    const { data: appt } = await supabase
      .from('appointments')
      .select('id, organization_id, lead_id, scheduled_at, ehr_sync_attempts')
      .eq('id', appointmentId)
      .single()
    if (!appt) return

    const { data: org } = await supabase
      .from('organizations')
      .select('dion_practice_id')
      .eq('id', appt.organization_id)
      .single()
    const dionPracticeId: string | null = org?.dion_practice_id ?? null

    // ── Leg 1: Dion Clinical ──────────────────────────────────────────────
    const dionResult =
      opts.action === 'book'
        ? await emitAppointmentBooked({ appointmentId: appt.id, startsAt: appt.scheduled_at, dionPracticeId })
        : await emitAppointmentCancelled({ appointmentId: appt.id, reasonCode: opts.reasonCode, dionPracticeId })

    const dion_sync_status = statusFrom(dionResult)
    await supabase
      .from('appointments')
      .update({
        dion_sync_status,
        ehr_sync_attempts: (appt.ehr_sync_attempts ?? 0) + 1,
        ehr_sync_error: dionResult.ok ? null : dionResult.error ?? null,
      })
      .eq('id', appt.id)

    if (!dionResult.ok && !dionResult.skipped) {
      await supabase.from('lead_activities').insert({
        organization_id: appt.organization_id,
        lead_id: appt.lead_id,
        activity_type: 'ehr_sync_failed',
        title: `Dion Clinical ${opts.action} sync failed`,
        metadata: { appointment_id: appt.id, leg: 'dion', error: dionResult.error ?? 'unknown' },
      })
    }

    // ── Leg 2: Slack / connectors (staff notification on booking) ─────────
    if (opts.action === 'book') {
      const { data: lead } = await supabase.from('leads').select('*').eq('id', appt.lead_id).single()
      if (lead) {
        dispatchConnectorEvent(supabase, {
          type: 'consultation.scheduled',
          organizationId: appt.organization_id,
          leadId: appt.lead_id,
          timestamp: new Date().toISOString(),
          data: {
            lead: buildConnectorLeadData(lead),
            metadata: { appointment_id: appt.id, scheduled_at: appt.scheduled_at },
          },
        }).catch(() => {
          /* connector dispatch is non-blocking; per-connector errors are logged internally */
        })
      }
    }

    // ── Leg 3: CareStack write — added in Phase 4 (carestack_sync_status stays 'pending') ──
  } catch {
    // The seam is fire-and-forget: never throw back into the booking flow.
  }
}
