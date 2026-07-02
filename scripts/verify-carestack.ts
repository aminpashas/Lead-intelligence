/**
 * Read-only CareStack connection check: request a token and read locations +
 * providers, to (1) validate credentials against the live API and (2) surface
 * the location/provider ids the booking write-leg uses as defaults.
 *
 * Creds come from env (no secrets in the file). Usage:
 *   CS_ACCOUNT_ID=… CS_CLIENT_ID=… CS_CLIENT_SECRET=… CS_USERNAME=… CS_PASSWORD=… \
 *   npx tsx scripts/verify-carestack.ts
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

import type { CareStackConfig } from '../src/lib/ehr/carestack/client'
import { getCsLocations, getCsProviders } from '../src/lib/ehr/carestack/scheduler'

function req(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`Missing env: ${name}`); process.exit(1) }
  return v
}

const cfg: CareStackConfig = {
  account_id: req('CS_ACCOUNT_ID'),
  client_id: req('CS_CLIENT_ID'),
  client_secret: req('CS_CLIENT_SECRET'),
  username: req('CS_USERNAME'),
  password: req('CS_PASSWORD'),
  base_url: process.env.CS_BASE_URL || 'https://pmsglobal.carestack.com',
  identity_url: process.env.CS_IDENTITY_URL || 'https://id.carestack.com',
}

async function main() {
  console.log(`Auth + read against ${cfg.base_url} (identity ${cfg.identity_url}) ...`)
  const [locations, providers] = await Promise.all([getCsLocations(cfg), getCsProviders(cfg)])

  console.log('\n✓ Token OK — credentials valid.\n')
  console.log('Locations:')
  for (const l of (locations as Array<{ id: number; name: string }>) ?? []) {
    console.log(`  id=${l.id}  ${l.name}`)
  }
  console.log('\nProviders:')
  for (const p of (providers as unknown as Array<Record<string, unknown>>) ?? []) {
    const name = (p.fullName as string) || `${(p.firstName as string) ?? ''} ${(p.lastName as string) ?? ''}`.trim()
    console.log(`  id=${p.id}  ${name}`)
  }
  console.log('\nUse the ids above as CS_LOCATION_ID / CS_PROVIDER_ID in the seed (optional — adapter falls back to the first of each).')
}

main().catch((e) => {
  console.error('FAILED:', e?.message ?? e)
  process.exit(1)
})
