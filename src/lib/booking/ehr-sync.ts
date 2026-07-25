/**
 * EHR appointment sync seam.
 *
 * The single place a booking create/cancel fans out to the outside world. Called
 * fire-and-forget from every write-site (public booking route, AI booking tool,
 * appointment status endpoint). It NEVER throws and NEVER blocks the booking —
 * a federation / PMS / Slack failure must not stop a confirmed consult.
 *
 * Legs (independent — one failing doesn't skip the others):
 *   1. Dion Clinical — emit appointment.booked / appointment.cancelled to the EMR bus.
 *   2. EHR adapters  — create / cancel in every configured PMS (see lib/ehr/registry).
 *   3. Slack / connectors — on `book`, dispatch consultation.scheduled (staff notify).
 *
 * Per-leg status is stored on the appointment row; the ehr-appointment-sync cron
 * re-drives any leg left 'pending'/'failed'.
 *
 * Multi-EMR: leg 2 loops the org's enabled adapters. An adapter without the
 * 'appointment.write' capability is `skipped`, not failed — read-only aggregator
 * tiers are a real configuration, not a bug.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { emitAppointmentBooked, emitAppointmentCancelled, type DionEmitResult } from '@/lib/bridges/dion-clinical'
import { dispatchConnectorEvent, buildConnectorLeadData } from '@/lib/connectors'
import { getEnabledAdapters, type ResolvedAdapter } from '@/lib/ehr/registry'
import type { EhrCtx } from '@/lib/ehr/port'
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
  ehr_external_ids: Record<string, string> | null
}

type LegResult = { status: EhrSyncStatus; error?: string }
type AdapterLegResult = LegResult & { source: string; externalId?: string }

function dionStatus(result: DionEmitResult): EhrSyncStatus {
  if (result.skipped) return 'skipped'
  return result.ok ? 'synced' : 'failed'
}

/**
 * The external id we already hold for this source, if any. Reads the multi-EMR
 * map first and falls back to the legacy CareStack column so the short-circuit
 * still works on rows written before the jsonb column existed.
 */
function existingExternalId(appt: AppointmentRow, source: string): string | null {
  const fromMap = appt.ehr_external_ids?.[source]
  if (fromMap) return fromMap
  if (source === 'carestack') return appt.carestack_appointment_id
  return null
}

async function runAdapterLeg(
  supabase: SupabaseClient,
  appt: AppointmentRow,
  lead: Record<string, unknown> | null,
  opts: EhrSyncOptions,
  { adapter, config }: ResolvedAdapter,
): Promise<AdapterLegResult> {
  const source = adapter.source
  if (!adapter.capabilities.has('appointment.write')) return { source, status: 'skipped' }

  const ctx: EhrCtx = { supabase, organizationId: appt.organization_id, config }
  const existing = existingExternalId(appt, source)

  try {
    if (opts.action === 'book') {
      // Idempotent: if we already created it (e.g. a retry where only the Dion leg
      // failed), don't create a second appointment in the PMS.
      if (existing) return { source, status: 'synced', externalId: existing }
      if (!lead) return { source, status: 'failed', error: `lead not found for ${source} patient` }
      const { externalId } = await adapter.createAppointment(ctx, {
        appointment: appt,
        lead,
      })
      return { source, status: 'synced', externalId }
    }
    // cancel — only meaningful if we actually created it in this PMS
    if (existing) await adapter.cancelAppointment(ctx, existing, opts.reasonCode)
    return { source, status: 'synced' }
  } catch (err) {
    return { source, status: 'failed', error: err instanceof Error ? err.message : `${source} error` }
  }
}

/**
 * Worst-of across every EHR leg, stored in the vendor-neutral `ehr_sync_status`
 * column so the retry cron can select on one indexable text field instead of a
 * jsonb predicate. Ordering: failed > pending > synced > skipped.
 */
function aggregateStatus(legs: AdapterLegResult[]): EhrSyncStatus {
  if (legs.length === 0) return 'skipped'
  if (legs.some((l) => l.status === 'failed')) return 'failed'
  if (legs.some((l) => l.status === 'pending')) return 'pending'
  if (legs.some((l) => l.status === 'synced')) return 'synced'
  return 'skipped'
}

export async function syncAppointmentToEhr(
  supabase: SupabaseClient,
  appointmentId: string,
  opts: EhrSyncOptions,
): Promise<void> {
  try {
    const { data: appt } = await supabase
      .from('appointments')
      .select('id, organization_id, lead_id, scheduled_at, duration_minutes, ehr_sync_attempts, carestack_appointment_id, ehr_external_ids')
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

    // Lead is only needed on `book` (Slack card + PMS patient resolution).
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

    // ── Leg 2: every configured EHR ───────────────────────────────────────
    // Sequential on purpose: these are low-volume writes to third-party PMSs,
    // and a serial loop keeps failure attribution and rate-limit behaviour simple.
    const adapters = await getEnabledAdapters(supabase, appointment.organization_id)
    const legs: AdapterLegResult[] = []
    for (const resolved of adapters) {
      legs.push(await runAdapterLeg(supabase, appointment, lead, opts, resolved))
    }

    // Single combined row update.
    const dion_sync_status = dionStatus(dionResult)
    const errorParts = [
      dionResult.ok ? null : dionResult.error,
      ...legs.filter((l) => l.status === 'failed').map((l) => `${l.source}: ${l.error}`),
    ].filter(Boolean)

    const carestackLeg = legs.find((l) => l.source === 'carestack')
    const update: Record<string, unknown> = {
      dion_sync_status,
      ehr_sync_attempts: (appointment.ehr_sync_attempts ?? 0) + 1,
      ehr_sync_error: errorParts.length ? errorParts.join(' | ') : null,
      // Legacy CareStack mirrors — kept for one release so the retry cron and any
      // reader of these columns keep working. Dropped once nothing reads them.
      carestack_sync_status: carestackLeg?.status ?? 'skipped',
    }
    if (carestackLeg?.externalId) update.carestack_appointment_id = carestackLeg.externalId
    await supabase.from('appointments').update(update).eq('id', appointment.id)

    // Multi-EMR link state, written separately so that on a pre-migration schema
    // (where these columns don't exist yet) the update above still lands.
    const externalIds = { ...(appointment.ehr_external_ids ?? {}) }
    for (const leg of legs) {
      if (leg.externalId) externalIds[leg.source] = leg.externalId
    }
    await supabase
      .from('appointments')
      .update({ ehr_external_ids: externalIds, ehr_sync_status: aggregateStatus(legs) })
      .eq('id', appointment.id)

    // Failure activity log per failed leg (best-effort, non-blocking).
    const failures: Array<{ leg: string; error?: string }> = []
    if (!dionResult.ok && !dionResult.skipped) failures.push({ leg: 'dion', error: dionResult.error })
    for (const l of legs) {
      if (l.status === 'failed') failures.push({ leg: l.source, error: l.error })
    }
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
