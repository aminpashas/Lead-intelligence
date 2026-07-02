/**
 * Availability overlay: turn external PMS occupancy (ehr_busy_slots, synced from
 * CareStack) into the ExistingAppointment shape the availability engine already
 * understands, so callers can merge it into what they pass to generateAvailableSlots.
 *
 * Empty table → empty array → zero effect, so this is safe to call unconditionally
 * even before any CareStack sync has run.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExistingAppointment } from './availability'

// Statuses that do NOT occupy a chair (so they must not block a slot). Covers both
// CareStack's "cancelled" spelling and LI's "canceled".
const NON_BLOCKING = new Set(['cancelled', 'canceled', 'no_show'])

export async function fetchEhrBusyAsAppointments(
  supabase: SupabaseClient,
  organizationId: string,
  advanceDays: number,
): Promise<ExistingAppointment[]> {
  const now = new Date()
  const until = new Date(now.getTime() + advanceDays * 24 * 60 * 60 * 1000)

  const { data } = await supabase
    .from('ehr_busy_slots')
    .select('starts_at, ends_at, status')
    .eq('organization_id', organizationId)
    .gte('starts_at', now.toISOString())
    .lte('starts_at', until.toISOString())

  if (!data) return []

  return (data as Array<{ starts_at: string; ends_at: string; status: string | null }>)
    .filter((r) => !r.status || !NON_BLOCKING.has(r.status.toLowerCase()))
    .map((r) => {
      const start = new Date(r.starts_at).getTime()
      const end = new Date(r.ends_at).getTime()
      const duration = Number.isFinite(end) && end > start ? Math.round((end - start) / 60_000) : 60
      // status 'scheduled' so the engine counts it as occupying the slot.
      return { scheduled_at: r.starts_at, duration_minutes: duration, status: 'scheduled' as const }
    })
}
