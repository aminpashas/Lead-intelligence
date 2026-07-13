/**
 * Existing-patient / junk re-match sweep.
 *
 * The CareStack `patients` mirror grows daily and enrichment backfills
 * phone_valid after ingestion, so call-sourced leads that looked new at ingest
 * become identifiable as existing patients / junk later. The ingestion reorder
 * only fires on new inbound, so this recurring sweep keeps the "New Lead" stage
 * from re-accumulating noise (see memory: existing-patient-reconciliation drift).
 *
 * Delegates to the set-based reclassify_off_funnel_contacts RPC per org — moves
 * `new`-stage call leads into the off-funnel parking stages and enqueues Desk
 * hand-offs. Scoped to `new` only, so worked leads are never disturbed.
 *
 * Schedule: hourly (vercel.json). Heartbeats via withCron.
 */
import { withCron } from '@/lib/cron/with-cron'

const PER_ORG_LIMIT = 2000

export const POST = withCron('existing-patient-rematch', async ({ supabase }) => {
  // Orgs that have the parking stages (i.e. the migration has run for them).
  const { data: orgRows } = await supabase
    .from('pipeline_stages')
    .select('organization_id')
    .eq('slug', 'existing-patient')

  const orgIds = Array.from(
    new Set((orgRows ?? []).map((r: { organization_id: string }) => r.organization_id)),
  )
  let existingPatientMoved = 0
  let junkMoved = 0

  for (const orgId of orgIds) {
    const { data, error } = await supabase.rpc('reclassify_off_funnel_contacts', {
      p_org: orgId,
      p_limit: PER_ORG_LIMIT,
    })
    if (error) throw new Error(`reclassify RPC failed for ${orgId}: ${error.message}`)
    const row = Array.isArray(data) ? data[0] : data
    existingPatientMoved += Number(row?.existing_patient_moved ?? 0)
    junkMoved += Number(row?.junk_moved ?? 0)
  }

  return {
    status: 'ok',
    items: existingPatientMoved + junkMoved,
    data: { orgs: orgIds.length, existingPatientMoved, junkMoved },
  }
})

// Vercel Cron invokes cron routes with a GET request; alias it to the POST
// handler so this scheduled route actually runs (matches every other cron route).
export const GET = POST
