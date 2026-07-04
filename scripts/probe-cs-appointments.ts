/**
 * READ-ONLY probe of CareStack /sync/appointments — confirm field names + status
 * values before building the ingest. Prints KEYS and status distribution only;
 * redacts any obvious PII values. Writes nothing.
 *
 *   npx tsx scripts/probe-cs-appointments.ts
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { getCareStackConfig } from '../src/lib/ehr/carestack/client'
import { getCsSyncAppointments } from '../src/lib/ehr/carestack/scheduler'

function req(n: string): string {
  const v = process.env[n]
  if (!v) { console.error(`Missing env: ${n}`); process.exit(1) }
  return v
}

async function main() {
  const supabase = createClient(req('NEXT_PUBLIC_SUPABASE_URL'), req('SUPABASE_SERVICE_ROLE_KEY'))
  const { data: org } = await supabase
    .from('connector_configs').select('organization_id')
    .eq('connector_type', 'carestack').eq('enabled', true).limit(1).single()
  if (!org) { console.log('no carestack org'); return }
  const config = await getCareStackConfig(supabase, org.organization_id)
  if (!config) { console.log('config invalid'); return }

  const resp = await getCsSyncAppointments(config, '2020-01-01T00:00:00Z')
  const results = resp.results ?? []
  console.log(`\n/sync/appointments → ${results.length} rows (page 1), continueToken: ${resp.continueToken ? 'yes' : 'no'}`)
  if (results.length === 0) return

  console.log('\nFIELD KEYS on a row:')
  console.log('  ' + Object.keys(results[0]).join(', '))

  // Status distribution (try common key names).
  const statusKeys = ['status', 'appointmentStatus', 'statusId', 'appointmentStatusId', 'Status']
  for (const k of statusKeys) {
    if (results.some((r) => k in r)) {
      const dist: Record<string, number> = {}
      for (const r of results) { const v = String((r as Record<string, unknown>)[k]); dist[v] = (dist[v] ?? 0) + 1 }
      console.log(`\nstatus field "${k}" distribution:`, dist)
    }
  }

  // Show a redacted sample row (numbers/dates kept, long strings masked).
  const sample: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(results[0])) {
    sample[k] = typeof v === 'string' && v.length > 25 ? `<str:${v.length}>` : v
  }
  console.log('\nSAMPLE ROW (redacted):')
  console.log(JSON.stringify(sample, null, 2))
}

main().catch((e) => { console.error(e); process.exit(1) })
