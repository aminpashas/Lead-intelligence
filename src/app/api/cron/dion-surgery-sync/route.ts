import { withCron } from '@/lib/cron/with-cron'
import { syncDionSurgeryStatusForCase, type DionSyncOutcome } from '@/lib/treatment/dion-surgery-sync'

/**
 * Refreshes the cached Dion Clinical surgery status for cases that were handed
 * off (dion_handoff_at set) but aren't yet terminal (dismissed/completed). Keeps
 * the Clinical Cases board's Surgery pill live without per-render federation
 * calls. Auth + heartbeat via withCron; bounded per run.
 */
export const maxDuration = 120

const BATCH = 200

const handler = withCron('dion-surgery-sync', async ({ supabase }) => {
  // Candidates: handed off, not yet terminal. Oldest-synced first so the poll
  // spreads evenly across runs.
  const { data: candidates, error } = await supabase
    .from('treatment_closings')
    .select('clinical_case_id')
    .not('dion_handoff_at', 'is', null)
    .not('clinical_case_id', 'is', null)
    .or('dion_surgery_status.is.null,dion_surgery_status.in.(open,scheduled)')
    .order('dion_synced_at', { ascending: true, nullsFirst: true })
    .limit(BATCH)
  if (error) throw new Error(error.message)

  const counts: Record<DionSyncOutcome, number> = {
    updated: 0, unchanged: 0, skipped: 0, not_found: 0, error: 0,
  }
  for (const c of candidates ?? []) {
    const caseId = c.clinical_case_id as string | null
    if (!caseId) continue
    try {
      counts[await syncDionSurgeryStatusForCase(supabase, caseId)]++
    } catch {
      counts.error++
    }
  }

  const processed = (candidates ?? []).length
  return { status: processed ? 'ok' : 'skipped', items: processed, data: { processed, ...counts } }
})

export const GET = handler
export const POST = handler
