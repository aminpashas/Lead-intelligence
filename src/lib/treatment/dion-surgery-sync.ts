import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchCaseSurgeryStatus } from '@/lib/bridges/dion-clinical'

/**
 * Pull a case's surgery status back from Dion Clinical and cache it onto the
 * treatment_closing (dion_surgery_status/date/synced_at). This is the LI half of
 * the read-back loop — the board's Surgery pill reads the cached columns so the
 * board stays fast (no per-render federation calls); a cron refreshes them.
 *
 * Never throws — the bridge itself is fail-soft; the worst case is a stale pill.
 */
export type DionSyncOutcome = 'updated' | 'unchanged' | 'skipped' | 'not_found' | 'error'

export async function syncDionSurgeryStatusForCase(
  supabase: SupabaseClient,
  caseId: string,
): Promise<DionSyncOutcome> {
  const { data: caseRow } = await supabase
    .from('clinical_cases')
    .select(`
      id, organization_id,
      treatment_closings!treatment_closings_clinical_case_id_fkey (id, dion_surgery_status, dion_surgery_date)
    `)
    .eq('id', caseId)
    .maybeSingle()
  if (!caseRow) return 'not_found'

  const closings = (caseRow as { treatment_closings?: unknown }).treatment_closings
  const closing = (Array.isArray(closings) ? closings[0] : closings) as
    | { id: string; dion_surgery_status: string | null; dion_surgery_date: string | null }
    | null
    | undefined
  if (!closing) return 'skipped' // no closing row to cache onto

  const { data: org } = await supabase
    .from('organizations')
    .select('dion_practice_id')
    .eq('id', caseRow.organization_id)
    .single()

  const res = await fetchCaseSurgeryStatus({
    caseId,
    dionPracticeId: (org?.dion_practice_id as string | null) ?? null,
  })
  if (res.skipped) return 'skipped'
  if (!res.ok) return 'error'

  const now = new Date().toISOString()
  if (!res.found) {
    // Stamp synced_at so we can back off, but don't invent a status.
    await supabase.from('treatment_closings').update({ dion_synced_at: now }).eq('id', closing.id)
    return 'unchanged'
  }

  const changed =
    closing.dion_surgery_status !== (res.surgeryStatus ?? null) ||
    closing.dion_surgery_date !== (res.surgeryDate ?? null)
  await supabase
    .from('treatment_closings')
    .update({
      dion_surgery_status: res.surgeryStatus ?? null,
      dion_surgery_date: res.surgeryDate ?? null,
      dion_synced_at: now,
    })
    .eq('id', closing.id)
  return changed ? 'updated' : 'unchanged'
}
