/**
 * EHR appointment sync retry cron.
 *
 * Re-drives appointments whose Dion Clinical OR EHR leg is still 'pending' or
 * 'failed' (up to MAX_ATTEMPTS). The seam (syncAppointmentToEhr) is idempotent —
 * the Dion envelope id is deterministic per (appointmentId, type) so a replay
 * dedupes on the receiver, and each PMS appointment is only created once (the
 * per-source external id short-circuits re-creation).
 *
 * ⚠ MULTI-EMR TODO: the filter below still keys off `carestack_sync_status`,
 * which the seam keeps mirrored, so this is correct while CareStack is the only
 * adapter. Once 20260725000000_ehr_multi_adapter_appointment_links.sql is applied
 * AND a second adapter is registered, widen the .or() to the vendor-neutral
 * `ehr_sync_status.in.(pending,failed)` — otherwise a failed non-CareStack leg
 * will never be retried. It is NOT widened here because referencing a column that
 * does not exist yet would error the whole query and silently stop all retries.
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
    // Re-drive rows where EITHER leg still needs work.
    .or('dion_sync_status.in.(pending,failed),carestack_sync_status.in.(pending,failed)')
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
