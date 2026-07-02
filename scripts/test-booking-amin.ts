/**
 * End-to-end CareStack write test with a REAL patient (Amin Samadian, DOB 1985-12-25),
 * exercising the exact adapter DTOs. Uses the "DO NOT USE (SSF)" test location so it
 * stays off a real clinic schedule. Reports the created appointment; does NOT delete
 * (so you can view it) — re-run with DELETE=1 to remove the appointment after.
 *   CS_* env … npx tsx scripts/test-booking-amin.ts
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })
import type { CareStackConfig } from '../src/lib/ehr/carestack/client'
import { carestackFetch } from '../src/lib/ehr/carestack/client'
import { getCsLocations, getCsProviders, getCsOperatories, searchCsPatients, createCsPatient, createCsAppointment } from '../src/lib/ehr/carestack/scheduler'

function req(n: string): string { const v = process.env[n]; if (!v) { console.error(`Missing env: ${n}`); process.exit(1) } return v }
const cfg: CareStackConfig = {
  account_id: req('CS_ACCOUNT_ID'), client_id: req('CS_CLIENT_ID'), client_secret: req('CS_CLIENT_SECRET'),
  username: req('CS_USERNAME'), password: req('CS_PASSWORD'),
  base_url: 'https://pmsglobal.carestack.com', identity_url: 'https://id.carestack.com',
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function short(e: unknown) { return (e as any)?.message ? String((e as any).message).slice(0, 300) : String(e) }

const PATIENT = { firstName: 'Amin', lastName: 'Samadian', dob: '1985-12-25', email: 'asamadian@dionhealth.com', mobile: undefined as string | undefined }

async function main() {
  const locations = (await getCsLocations(cfg)) as Array<{ id: number; name: string }>
  const operatories = (await getCsOperatories(cfg)) as Array<{ id: number; locationId: number }>
  const providers = (await getCsProviders(cfg)) as Array<{ id: number }>
  const loc = locations.find((l) => /do not use/i.test(l.name)) ?? locations[0]
  const op = operatories.find((o) => o.locationId === loc.id) ?? operatories[0]
  const providerId = providers[0]?.id
  console.log(`location=${loc.id} (${loc.name}) operatory=${op?.id} provider=${providerId}\n`)

  // 1. Find or create Amin's patient (mirrors ensureCareStackPatient).
  let patientId: number | string | undefined
  try {
    const hits = (await searchCsPatients(cfg, { email: PATIENT.email })) as Array<{ id?: number; patientId?: number; firstName?: string; lastName?: string }>
    if (Array.isArray(hits) && hits.length) {
      patientId = hits[0].id ?? hits[0].patientId
      console.log(`✓ found existing patient by email → id=${patientId} (${hits[0].firstName} ${hits[0].lastName})`)
    }
  } catch (e) { console.log('search:', short(e)) }

  if (!patientId) {
    try {
      const created = await createCsPatient(cfg, {
        firstName: PATIENT.firstName, lastName: PATIENT.lastName, dob: PATIENT.dob,
        gender: 4, defaultLocationId: loc.id, email: PATIENT.email,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      patientId = (created as { id?: number; patientId?: number }).id ?? (created as { patientId?: number }).patientId
      console.log(`✓ created patient Amin Samadian (DOB 1985-12-25) → id=${patientId}`)
    } catch (e) {
      // Search can miss an existing patient (different email on file); create then
      // 409s with the real id: "Duplicate Ids 1795". Reuse it.
      const dup = short(e).match(/Duplicate Ids?\s+(\d+)/i)
      if (short(e).includes('409') && dup) {
        patientId = Number(dup[1])
        console.log(`✓ patient already exists → id=${patientId} (409 duplicate; reusing)`)
      } else { throw e }
    }
  }

  // 2. Book a test appointment ~10 days out at 2pm UTC.
  const start = new Date('2026-07-13T21:00:00.000Z') // ~2pm PT
  const created = await createCsAppointment(cfg, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    patientId: patientId as any, locationId: loc.id, providerIds: [providerId], operatoryId: op?.id,
    startDateTime: start.toISOString(), duration: 60, notes: 'TEST — online booking integration (Amin, safe to delete)',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
  const apptId = (created as { id: number }).id
  console.log(`\n✓ BOOKED test appointment → id=${apptId}`)
  console.log('  response:', JSON.stringify(created).slice(0, 400))
  console.log(`\n  Patient id=${patientId}, Appointment id=${apptId}, at ${loc.name} on ${start.toISOString()}`)

  if (process.env.DELETE === '1' && apptId != null) {
    await carestackFetch(cfg, `/appointments/${apptId}`, { method: 'DELETE' })
    console.log(`  ✓ deleted appointment ${apptId} (DELETE=1)`)
  } else {
    console.log(`\n  Left in place so you can view it. To remove: DELETE=1 … npx tsx scripts/test-booking-amin.ts (books again) — or tell me and I'll delete appointment ${apptId}.`)
  }
}

main().catch((e) => { console.error('FAILED:', short(e)); process.exit(1) })
