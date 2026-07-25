/**
 * CareStack as an EhrAdapter — adapter #1.
 *
 * Deliberately thin: every function it calls already existed and is unchanged.
 * This file only adapts their shapes to the port, so wrapping CareStack carried
 * no behavioural risk. A second EMR implements the same interface and plugs in
 * via registry.ts without touching the booking seam, the cron, or the rollup.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { EhrAdapter, EhrCtx, SyncRun, CreateAppointmentInput } from '../port'
import { getCareStackConfig, type CareStackConfig } from './client'
import { pushAppointmentToCareStack, cancelAppointmentInCareStack, type CareStackBookingDefaults } from './appointments'
import { syncPatients, syncTreatmentProcedures, syncInvoices, syncCareStackAppointments } from './sync'
import { syncCareStackBusySlots } from './busy-sync'
import { rematchUnlinkedPatients } from './rematch'
import { normalizeProcedureStatus, normalizeAppointmentStatus } from './status'

const cfg = (ctx: EhrCtx) => ctx.config as CareStackConfig

/**
 * The org's CareStack booking defaults. These column names are CareStack's model
 * (location / provider / operatory / production type) and don't generalize, so
 * reading them belongs to this adapter rather than the shared booking seam.
 */
async function bookingDefaults(supabase: SupabaseClient, organizationId: string): Promise<CareStackBookingDefaults> {
  const { data } = await supabase
    .from('booking_settings')
    .select('carestack_location_id, carestack_provider_id, carestack_operatory_id, carestack_appointment_type, timezone')
    .eq('organization_id', organizationId)
    .maybeSingle()
  return (data ?? {}) as CareStackBookingDefaults
}

export const carestackAdapter: EhrAdapter = {
  source: 'carestack',

  capabilities: new Set([
    'appointment.write',
    'busy.sync',
    'patient.search',
    'outcomes.sync',
  ] as const),

  getConfig(supabase, organizationId) {
    return getCareStackConfig(supabase, organizationId)
  },

  async createAppointment(ctx: EhrCtx, input: CreateAppointmentInput): Promise<{ externalId: string }> {
    const settings = await bookingDefaults(ctx.supabase, ctx.organizationId)
    const externalId = await pushAppointmentToCareStack(ctx.supabase, cfg(ctx), {
      appointment: input.appointment,
      lead: input.lead,
      settings,
    })
    return { externalId }
  },

  async cancelAppointment(ctx: EhrCtx, externalId: string): Promise<void> {
    await cancelAppointmentInCareStack(cfg(ctx), externalId)
  },

  /**
   * Ordering matters and is CareStack's own: patients must refresh first so the
   * later runners can resolve patient → lead links, and the appointment pull must
   * land before the cron's consult rollup reads it. Every step re-checks the
   * deadline — with more than one adapter per org the budget is tighter, not looser.
   */
  async runSync(ctx: EhrCtx): Promise<SyncRun[]> {
    const { supabase, organizationId, deadlineAt } = ctx
    const config = cfg(ctx)
    const overBudget = () => deadlineAt !== undefined && Date.now() >= deadlineAt
    const runs: SyncRun[] = []

    runs.push(await syncPatients(supabase, organizationId, config, deadlineAt))
    if (!overBudget()) runs.push(await syncTreatmentProcedures(supabase, organizationId, config, deadlineAt))
    if (!overBudget()) runs.push(await syncInvoices(supabase, organizationId, config, deadlineAt))
    if (!overBudget()) runs.push(await syncCareStackBusySlots(supabase, organizationId, config, deadlineAt))
    if (!overBudget()) runs.push(await syncCareStackAppointments(supabase, organizationId, config, deadlineAt))

    // Re-match sweep — link already-synced patients back to leads (most synced
    // before their lead was hashed, so lead_id sits null). Must run before the
    // cron's rollups so newly-linked patients get their $ rolled up this pass.
    if (!overBudget()) {
      const rematch = await rematchUnlinkedPatients(supabase, organizationId)
      runs.push({
        resource: rematch.resource,
        fetched: rematch.patients_scanned,
        upserted: rematch.newly_matched,
        events_emitted: 0,
        status: rematch.status,
        error: rematch.error,
      })
    }

    return runs
  },

  normalizeProcedureStatus,
  normalizeAppointmentStatus,
}
