/**
 * Nail the CareStack create DTOs (patient + appointment) against the live API,
 * minimal footprint: test location "DO NOT USE (SSF)", far-future slot, delete the
 * appointment after, flag the one test patient for cleanup.
 * Iterates the `gender` enum format until patient-create is accepted.
 *   CS_ACCOUNT_ID=… … npx tsx scripts/verify-carestack-create.ts
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

import type { CareStackConfig } from '../src/lib/ehr/carestack/client'
import { carestackFetch } from '../src/lib/ehr/carestack/client'
import { getCsLocations, getCsProviders, getCsOperatories } from '../src/lib/ehr/carestack/scheduler'

function req(n: string): string { const v = process.env[n]; if (!v) { console.error(`Missing env: ${n}`); process.exit(1) } return v }
const cfg: CareStackConfig = {
  account_id: req('CS_ACCOUNT_ID'), client_id: req('CS_CLIENT_ID'), client_secret: req('CS_CLIENT_SECRET'),
  username: req('CS_USERNAME'), password: req('CS_PASSWORD'),
  base_url: 'https://pmsglobal.carestack.com', identity_url: 'https://id.carestack.com',
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function short(e: unknown) { return (e as any)?.message ? String((e as any).message).slice(0, 400) : String(e) }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const post = (path: string, body: unknown) => carestackFetch<any>(cfg, path, { method: 'POST', body })

async function main() {
  const locations = (await getCsLocations(cfg)) as Array<{ id: number; name: string }>
  const providers = (await getCsProviders(cfg)) as Array<{ id: number }>
  const operatories = (await getCsOperatories(cfg)) as Array<{ id: number; locationId: number }>
  const loc = locations.find((l) => /do not use|test/i.test(l.name)) ?? locations[0]
  const op = operatories.find((o) => o.locationId === loc.id) ?? operatories[0]
  const providerId = providers[0]?.id
  console.log(`location=${loc.id} operatory=${op?.id} provider=${providerId}\n`)

  // ── 1. Patient create — MDRCM's proven field names (dob, gender:4=NotSet,
  //    defaultLocationId, mobile). ──
  const patientBody = {
    firstName: 'ZZAPITEST', lastName: 'DELETE-ME-API-CHECK',
    dob: '1990-01-01', gender: 4, defaultLocationId: loc.id,
    email: 'zzapitest-delete@example.invalid',
  }
  let patient: { id?: number; patientId?: number } | null = null
  try {
    console.log('POST /patients body:', JSON.stringify(patientBody))
    patient = await post('/patients', patientBody)
    console.log(`✓ createPatient OK → ${JSON.stringify(patient).slice(0, 200)}`)
  } catch (e) {
    console.log('✗ createPatient FAILED:', short(e))
    return
  }
  const patientId = patient!.id ?? patient!.patientId

  // ── 2. Appointment create — our body shape ──
  const startDateTime = '2027-03-15T18:00:00.000Z'
  let apptId: number | undefined
  const apptBody = { patientId, locationId: loc.id, providerIds: [providerId], operatoryId: op?.id, startDateTime, duration: 60, notes: 'API DTO verification — delete' }
  console.log('\nPOST /appointments body:', JSON.stringify(apptBody))
  try {
    const created = await post('/appointments', apptBody)
    apptId = created.id
    console.log('✓ createAppointment OK →', JSON.stringify(created).slice(0, 300))
  } catch (e) {
    console.log('✗ createAppointment FAILED:', short(e))
  }

  // ── 3. Cleanup ──
  if (apptId != null) {
    try { await carestackFetch(cfg, `/appointments/${apptId}`, { method: 'DELETE' }); console.log(`✓ deleted appointment ${apptId}`) }
    catch (e) { console.log(`⚠️ delete appointment ${apptId}:`, short(e)) }
  }
  console.log(`\nWorking gender format: ${JSON.stringify(patientBody.gender)}`)
  console.log(`Cleanup: inactivate/remove test patient id=${patientId} (ZZAPITEST DELETE-ME-API-CHECK).`)
}

main().catch((e) => { console.error('FAILED:', short(e)); process.exit(1) })
