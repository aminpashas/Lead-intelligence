/**
 * EHR appointment sync retry cron.
 *
 * Re-drives appointments whose Dion Clinical leg is still 'pending' or 'failed'
 * (up to MAX_ATTEMPTS). The seam (syncAppointmentToEhr) is idempotent — the Dion
 * envelope id is deterministic per (appointmentId, type), so a replay dedupes on
 * the receiver instead of duplicating the chart entry.
 *
 * (The CareStack write leg is added in Phase 4; this cron will then also re-drive
 * carestack_sync_status.)
 *
 * Schedule: every 5 minutes (vercel.json). Guarded by CRON_SECRET via withCron.
 */
import { withCron } from '@/lib/cron/with-cron'
import { syncAppointmentToEhr } from '@/lib/booking/ehr-sync'

export const dynamic = 'force-dynamic'

const BATCH_SIZE = 50
const MAX_ATTEMPTS = 5

export const POST = withCron('ehr-appointment-sync', async ({ supabase }) => {
  const { data: rows } = await supabase
    .from('appointments')
    .select('id, status, ehr_sync_attempts')
    .in('dion_sync_status', ['pending', 'failed'])
    .lt('ehr_sync_attempts', MAX_ATTEMPTS)
    .limit(BATCH_SIZE)

  const list = rows ?? []
  for (const r of list) {
    const isCancel = r.status === 'canceled' || r.status === 'no_show'
    await syncAppointmentToEhr(supabase, r.id, {
      action: isCancel ? 'cancel' : 'book',
      reasonCode: r.status === 'no_show' ? 'no-show' : isCancel ? 'patient-cancel' : undefined,
    })
  }

  return {
    status: list.length > 0 ? 'ok' : 'skipped',
    items: list.length,
    data: { processed: list.length },
  }
})

export const GET = POST
