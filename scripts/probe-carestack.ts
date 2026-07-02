/**
 * Read-only probe of the two CareStack request shapes my code uses but hasn't
 * live-tested: patient SEARCH (which param?) and sync/appointments (field names).
 * Prints statuses + field KEYS only — never patient values (no PHI in output).
 * Does NOT create/modify anything.
 *   CS_ACCOUNT_ID=… CS_CLIENT_ID=… … npx tsx scripts/probe-carestack.ts
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

import type { CareStackConfig } from '../src/lib/ehr/carestack/client'
import { searchCsPatients, getCsSyncAppointments } from '../src/lib/ehr/carestack/scheduler'

function req(n: string): string { const v = process.env[n]; if (!v) { console.error(`Missing env: ${n}`); process.exit(1) } return v }
const cfg: CareStackConfig = {
  account_id: req('CS_ACCOUNT_ID'), client_id: req('CS_CLIENT_ID'), client_secret: req('CS_CLIENT_SECRET'),
  username: req('CS_USERNAME'), password: req('CS_PASSWORD'),
  base_url: 'https://pmsglobal.carestack.com', identity_url: 'https://id.carestack.com',
}

const FAKE = 'zzz-verify-probe-no-such@example.invalid'

async function trySearch(label: string, body: Record<string, unknown>) {
  try {
    const res = await searchCsPatients(cfg, body)
    console.log(`  ${label}: 200 OK — ${Array.isArray(res) ? res.length : '?'} result(s)`)
  } catch (e) {
    console.log(`  ${label}: ${(e as Error).message.split(':').slice(0, 2).join(':').slice(0, 80)}`)
  }
}

async function main() {
  console.log('Patient search — which body shape is accepted? (fake value, expect 0 results):')
  await trySearch("{ email }", { email: FAKE })
  await trySearch("{ firstName }", { firstName: 'ZzVerifyProbe' })
  await trySearch("{ searchString }", { searchString: FAKE })
  await trySearch("{ email, pageNumber, pageSize }", { email: FAKE, pageNumber: 1, pageSize: 1 })

  console.log('\nsync/appointments — field names on a real row (keys only, no values):')
  try {
    const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
    const resp = await getCsSyncAppointments(cfg, since)
    const rows = resp.results ?? []
    console.log(`  fetched ${rows.length} row(s) since ${since}`)
    if (rows.length) console.log('  keys:', Object.keys(rows[0] as Record<string, unknown>).join(', '))
    console.log('  continueToken present:', resp.continueToken != null)
  } catch (e) {
    console.log(`  sync/appointments: ${(e as Error).message.slice(0, 120)}`)
  }
}

main().catch((e) => { console.error('FAILED:', e?.message ?? e); process.exit(1) })
