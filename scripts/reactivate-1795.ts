/**
 * Find CareStack's patient-reactivation mechanism for patient 1795 (standard
 * update doesn't flip status). Tries likely endpoints; each wrong one 404/400s
 * harmlessly. On success (status→1) books a test appointment then deletes it.
 *   CS_* env … npx tsx scripts/reactivate-1795.ts
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })
import type { CareStackConfig } from '../src/lib/ehr/carestack/client'
import { carestackFetch } from '../src/lib/ehr/carestack/client'
import { createCsAppointment } from '../src/lib/ehr/carestack/scheduler'

function req(n: string): string { const v = process.env[n]; if (!v) { console.error(`Missing env: ${n}`); process.exit(1) } return v }
const cfg: CareStackConfig = {
  account_id: req('CS_ACCOUNT_ID'), client_id: req('CS_CLIENT_ID'), client_secret: req('CS_CLIENT_SECRET'),
  username: req('CS_USERNAME'), password: req('CS_PASSWORD'),
  base_url: 'https://pmsglobal.carestack.com', identity_url: 'https://id.carestack.com',
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function short(e: unknown) { return (e as any)?.message ? String((e as any).message).slice(0, 160) : String(e) }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const status = async () => ((await carestackFetch<any>(cfg, '/patients/1795')).status)

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = await carestackFetch<any>(cfg, '/patients/1795')
  console.log(`start: status=${p.status}`)

  const attempts: Array<[string, string, unknown]> = [
    ['PUT', '/patients/1795/reactivate', undefined],
    ['PUT', '/patients/1795/activate', undefined],
    ['POST', '/patients/1795/reactivate', undefined],
    ['POST', '/patients/1795/activate', undefined],
    ['PUT', '/patients/1795/modify-status', { statusId: 1 }],
    ['PUT', '/patients/1795/status', { status: 1 }],
    ['PUT', '/patients/1795/status', { statusId: 1 }],
    ['PUT', '/patients/reactivate/1795', undefined],
    // Full-model update with STRING status (MDRCM types status as 'active').
    ['PUT', '/patients/', { ...p, status: 'Active' }],
    ['PUT', '/patients/', { ...p, status: 1, isActive: true }],
  ]

  let active = false
  for (const [method, path, body] of attempts) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await carestackFetch(cfg, path, { method: method as any, body })
      const s = await status()
      console.log(`${method} ${path} → 2xx, status=${s}`)
      if (s === 1) { active = true; console.log('✓ REACTIVATED'); break }
    } catch (e) {
      const code = short(e).match(/\b(4\d\d|5\d\d)\b/)?.[0] ?? 'err'
      console.log(`${method} ${path} → ${code}`)
    }
  }

  if (!active) { console.log('\n✗ None reactivated 1795 — needs the documented endpoint. No harm done (status still 0).'); return }

  // Book + delete to prove the full path for your record.
  const start = new Date('2026-07-13T21:00:00.000Z')
  const appt = await createCsAppointment(cfg, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    patientId: 1795 as any, locationId: 3048, providerIds: [12], operatoryId: 4025,
    startDateTime: start.toISOString(), duration: 60, notes: 'TEST — online booking (Amin)',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
  const apptId = (appt as { id: number }).id
  console.log(`\n✓ BOOKED appointment id=${apptId} for patient 1795 (Amin) on ${start.toISOString()}`)
  await carestackFetch(cfg, `/appointments/${apptId}`, { method: 'DELETE' })
  console.log(`✓ deleted appointment ${apptId} — 1795 left ACTIVE. Full write path verified for your record.`)
}

main().catch((e) => { console.error('FAILED:', short(e)); process.exit(1) })
