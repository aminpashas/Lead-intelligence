/**
 * CareStack incremental sync — daily.
 *
 * For every org with a CareStack connector configured, run the resource sync
 * runners in order:
 *   1. patients              (refresh bridge table)
 *   2. treatment_procedures  (emits lead.treatment_accepted / .completed)
 *   3. invoices              (emits lead.payment.received)
 *
 * Each runner is independently retryable and idempotent. The events emitted go
 * into the `events` table where the existing forward-events cron picks them up
 * and ships to Meta CAPI / Google Ads as Purchase / value-bearing conversions.
 *
 * Vercel cron: 30 04 * * * (04:30 UTC daily) — runs before forward-events
 * (every 15 min) so newly emitted events get one ship attempt within ~15 min.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { getCareStackConfig } from '@/lib/ehr/carestack/client'
import { syncPatients, syncTreatmentProcedures, syncInvoices } from '@/lib/ehr/carestack/sync'

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()

  // All orgs with a CareStack connector configured AND enabled.
  const { data: orgs } = await supabase
    .from('connector_configs')
    .select('organization_id')
    .eq('connector_type', 'carestack')
    .eq('enabled', true)

  if (!orgs || orgs.length === 0) {
    return NextResponse.json({ message: 'No CareStack integrations configured', orgs: 0 })
  }

  const results: Array<{
    organization_id: string
    runs: Array<{
      resource: string
      fetched: number
      upserted: number
      events_emitted: number
      status: string
      error?: string
    }>
  }> = []

  for (const org of orgs as Array<{ organization_id: string }>) {
    const config = await getCareStackConfig(supabase, org.organization_id)
    if (!config) {
      results.push({
        organization_id: org.organization_id,
        runs: [{ resource: 'config', fetched: 0, upserted: 0, events_emitted: 0, status: 'failed', error: 'config_invalid' }],
      })
      continue
    }

    const runs: Array<{ resource: string; fetched: number; upserted: number; events_emitted: number; status: string; error?: string }> = []

    // 1) Patients — refresh the bridge table first so subsequent runners
    //    can resolve patient → lead links via cached fields.
    runs.push(await syncPatients(supabase, org.organization_id, config))

    // 2) Treatment procedures — emits the revenue-bearing events.
    runs.push(await syncTreatmentProcedures(supabase, org.organization_id, config))

    // 3) Invoices — emits actual collected revenue.
    runs.push(await syncInvoices(supabase, org.organization_id, config))

    results.push({ organization_id: org.organization_id, runs })
  }

  return NextResponse.json({ orgs: results.length, results })
}

export const GET = POST
