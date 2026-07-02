/**
 * Read-only: report what's already provisioned for the online-booking EHR
 * integration on the LIVE LI database, so we don't seed blindly.
 *   npx tsx scripts/inspect-booking-state.ts
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'

const ORG = process.env.BOOKING_ORG_ID || 'fa64e53c-3d9b-493e-b904-59580cb3f29c'

async function main() {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

  // Connectors for this org (no credentials selected).
  const { data: connectors } = await db
    .from('connector_configs')
    .select('connector_type, enabled')
    .eq('organization_id', ORG)
  console.log('connector_configs for org:', connectors ?? [])

  // booking_settings existence + whether the new CareStack columns exist.
  const bs = await db.from('booking_settings').select('organization_id, is_enabled, carestack_location_id').eq('organization_id', ORG).maybeSingle()
  console.log('booking_settings:', bs.error ? `ERROR (${bs.error.message})` : (bs.data ?? 'NONE'))

  // Migration 1 applied? (appointments.carestack_sync_status)
  const ap = await db.from('appointments').select('carestack_sync_status').limit(1)
  console.log('appointments.carestack_sync_status column:', ap.error ? `MISSING (${ap.error.message})` : 'present')

  // Migration 2 applied? (ehr_busy_slots table)
  const bsy = await db.from('ehr_busy_slots').select('id').limit(1)
  console.log('ehr_busy_slots table:', bsy.error ? `MISSING (${bsy.error.message})` : 'present')

  // organizations.dion_practice_id column + current value.
  const org = await db.from('organizations').select('name, dion_practice_id').eq('id', ORG).maybeSingle()
  console.log('organizations:', org.error ? `dion_practice_id MISSING (${org.error.message})` : org.data)
}

main().catch((e) => { console.error('FAILED:', e?.message ?? e); process.exit(1) })
