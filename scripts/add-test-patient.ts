/**
 * One-off: add Amin as a test patient/lead in Dion Health San Francisco, with
 * SMS consent recorded (he explicitly opted in by requesting the test text).
 *
 * Mirrors POST /api/leads: resolve default stage, encrypt PII at rest, insert,
 * log a lead_activities row. Idempotent — skips if a lead with this phone hash
 * already exists.
 *
 * Usage: npx tsx scripts/add-test-patient.ts
 * Env (from .env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ENCRYPTION_KEY
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { encryptLeadPII, searchHash } from '../src/lib/encryption'

const ORG_ID = 'fa64e53c-3d9b-493e-b904-59580cb3f29c' // Dion Health San Francisco
const PHONE = '4156767420'
const PHONE_E164 = '+14156767420'

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  if (!url || !key) throw new Error('Missing Supabase env')
  const supabase = createClient(url, key)

  // Idempotency: bail if a lead with this phone already exists in the org.
  const phoneHash = searchHash(PHONE_E164)
  const { data: existing } = await supabase
    .from('leads')
    .select('id')
    .eq('organization_id', ORG_ID)
    .eq('phone_hash', phoneHash)
    .maybeSingle()
  if (existing) {
    console.log('Lead already exists:', existing.id, '— skipping insert.')
    return
  }

  const { data: defaultStage } = await supabase
    .from('pipeline_stages')
    .select('id, name')
    .eq('organization_id', ORG_ID)
    .eq('is_default', true)
    .single()

  const now = new Date().toISOString()
  const insertData = encryptLeadPII({
    organization_id: ORG_ID,
    stage_id: defaultStage?.id,
    first_name: 'Amin',
    last_name: 'Samadian',
    phone: PHONE,
    phone_formatted: PHONE_E164,
    source_type: 'manual_test',
    // Consent: explicit opt-in via direct request to be texted.
    sms_consent: true,
    sms_consent_at: now,
    sms_consent_source: 'self_opt_in_go_live_test',
  })

  const { data: lead, error } = await supabase
    .from('leads')
    .insert(insertData)
    .select('id, first_name, last_name, status')
    .single()
  if (error) throw error

  await supabase.from('lead_activities').insert({
    organization_id: ORG_ID,
    lead_id: lead.id,
    activity_type: 'created',
    title: 'Lead created',
    description: 'Amin Samadian added to pipeline (10DLC go-live SMS test)',
  })

  console.log('Created lead:', lead.id)
  console.log('  name:', lead.first_name, lead.last_name)
  console.log('  status:', lead.status)
  console.log('  stage:', defaultStage?.name ?? '(none)')
  console.log('  sms_consent: true (source: self_opt_in_go_live_test)')
}

main().catch((e) => {
  console.error('FAILED:', e.message ?? e)
  process.exit(1)
})
