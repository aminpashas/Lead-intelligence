/**
 * Reactivate patient 1795 (Amin), book a test appointment at the DO-NOT-USE
 * location to prove the flow, then DELETE the appointment (leaving 1795 active).
 *   CS_* env … npx tsx scripts/reactivate-and-book-amin.ts
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })
import type { CareStackConfig } from '../src/lib/ehr/carestack/client'
import { carestackFetch } from '../src/lib/ehr/carestack/client'
import { getCsLocations, getCsProviders, getCsOperatories, createCsAppointment } from '../src/lib/ehr/carestack/scheduler'

function req(n: string): string { const v = process.env[n]; if (!v) { console.error(`Missing env: ${n}`); process.exit(1) } return v }
const cfg: CareStackConfig = {
  account_id: req('CS_ACCOUNT_ID'), client_id: req('CS_CLIENT_ID'), client_secret: req('CS_CLIENT_SECRET'),
  username: req('CS_USERNAME'), password: req('CS_PASSWORD'),
  base_url: 'https://pmsglobal.carestack.com', identity_url: 'https://id.carestack.com',
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function short(e: unknown) { return (e as any)?.message ? String((e as any).message).slice(0, 300) : String(e) }
const PID = 1795

async function main() {
  // 1. Fetch the current record + reactivate (round-trip full model with status=1).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const patient = await carestackFetch<any>(cfg, `/patients/${PID}`)
  console.log(`patient ${PID}: ${patient.firstName} ${patient.lastName}, status=${patient.status}, dob=${patient.dob ?? patient.dateOfBirth}`)
  if (patient.status !== 1) {
    await carestackFetch(cfg, '/patients/', { method: 'PUT', body: { ...patient, status: 1 } })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const after = await carestackFetch<any>(cfg, `/patients/${PID}`)
    console.log(`✓ reactivated → status=${after.status}`)
  } else {
    console.log('already active')
  }

  // 2. Book a test appointment at the DO-NOT-USE location.
  const locations = (await getCsLocations(cfg)) as Array<{ id: number; name: string }>
  const operatories = (await getCsOperatories(cfg)) as Array<{ id: number; locationId: number }>
  const providers = (await getCsProviders(cfg)) as Array<{ id: number }>
  const loc = locations.find((l) => /do not use/i.test(l.name)) ?? locations[0]
  const op = operatories.find((o) => o.locationId === loc.id) ?? operatories[0]
  const providerId = providers[0]?.id

  const start = new Date('2026-07-13T21:00:00.000Z')
  const created = await createCsAppointment(cfg, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    patientId: PID as any, locationId: loc.id, providerIds: [providerId], operatoryId: op?.id,
    startDateTime: start.toISOString(), duration: 60, notes: 'TEST — online booking integration (Amin)',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
  const apptId = (created as { id: number }).id
  console.log(`\n✓ BOOKED test appointment id=${apptId} for patient ${PID} at ${loc.name} on ${start.toISOString()}`)
  console.log('  response:', JSON.stringify(created).slice(0, 350))

  // 3. Delete the appointment (leave 1795 active per your choice).
  await carestackFetch(cfg, `/appointments/${apptId}`, { method: 'DELETE' })
  console.log(`✓ deleted test appointment ${apptId} — patient ${PID} left ACTIVE`)
  console.log('\nResult: reactivate → book → delete all succeeded. The write path works end-to-end for your record.')
}

main().catch((e) => { console.error('FAILED:', short(e)); process.exit(1) })
