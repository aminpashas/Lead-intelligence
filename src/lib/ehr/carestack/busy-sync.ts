/**
 * Pull CareStack appointment occupancy into ehr_busy_slots so LI's availability
 * engine won't offer a chair that's actually booked in the PMS. Runs from the
 * carestack-sync cron (per org, only when CareStack is configured).
 *
 * The /sync/appointments endpoint is incremental (modifiedSince) and returns start
 * + duration (no explicit end). Field names mirror the sibling MDRCM import.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CareStackConfig } from './client'
import { getCsSyncAppointments } from './scheduler'

const LOOKBACK_DAYS = 30
const MAX_PAGES = 50

export type BusySyncRun = {
  resource: string
  fetched: number
  upserted: number
  events_emitted: number
  status: string
  error?: string
}

function mapStatus(raw: unknown): string {
  const s = String(raw ?? '').toLowerCase()
  if (s.includes('confirmed')) return 'confirmed'
  if (s.includes('check') && s.includes('out')) return 'completed'
  if (s.includes('cancel') || s.includes('deleted')) return 'cancelled'
  if (s.includes('no show') || s.includes('no_show') || s.includes('noshow')) return 'no_show'
  return 'scheduled'
}

export async function syncCareStackBusySlots(
  supabase: SupabaseClient,
  organizationId: string,
  config: CareStackConfig,
): Promise<BusySyncRun> {
  const modifiedSince = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()
  let continueToken: string | undefined
  let fetched = 0
  let upserted = 0

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const resp = await getCsSyncAppointments(config, modifiedSince, continueToken)
      const rows = resp.results ?? []
      fetched += rows.length

      const mapped = rows
        .map((row) => {
          const a = row as Record<string, unknown>
          const startRaw = (a.startDateTime ?? a.startTime ?? a.scheduledStart) as string | undefined
          const startMs = startRaw ? new Date(startRaw).getTime() : NaN
          const id = a.id ?? a.appointmentId
          if (id == null || !startRaw || Number.isNaN(startMs)) return null
          const durationMin = typeof a.duration === 'number' ? a.duration : 60
          return {
            organization_id: organizationId,
            ehr_source: 'carestack',
            ehr_appointment_id: String(id),
            ehr_patient_id: a.patientId != null ? String(a.patientId) : null,
            starts_at: new Date(startMs).toISOString(),
            ends_at: new Date(startMs + durationMin * 60_000).toISOString(),
            status: mapStatus(a.status),
            appointment_type: a.productionTypeId != null ? String(a.productionTypeId) : null,
          }
        })
        .filter((r): r is NonNullable<typeof r> => r !== null)

      if (mapped.length) {
        const { error } = await supabase
          .from('ehr_busy_slots')
          .upsert(mapped, { onConflict: 'organization_id,ehr_source,ehr_appointment_id' })
        if (error) throw new Error(error.message)
        upserted += mapped.length
      }

      continueToken = resp.continueToken ?? undefined
      if (!continueToken) break
    }
    return { resource: 'busy_slots', fetched, upserted, events_emitted: 0, status: 'ok' }
  } catch (err) {
    return {
      resource: 'busy_slots',
      fetched,
      upserted,
      events_emitted: 0,
      status: 'failed',
      error: err instanceof Error ? err.message : 'busy sync error',
    }
  }
}
