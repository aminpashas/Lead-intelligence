/**
 * Seed the online-booking EHR integration for ONE practice org.
 *
 * Idempotent. Reads every real value from env (no secrets in code). Run this
 * AFTER applying the two migrations:
 *   supabase/migrations/20260701_ehr_appointment_sync.sql
 *   supabase/migrations/20260701_ehr_busy_slots.sql
 *
 * Required:
 *   BOOKING_ORG_ID            practice organization id (uuid)
 * CareStack legs (provide ALL to enable write-back + availability):
 *   CS_ACCOUNT_ID CS_CLIENT_ID CS_CLIENT_SECRET CS_USERNAME CS_PASSWORD
 *   CS_WEBHOOK_SECRET   (optional, for the inbound webhook)
 *   CS_BASE_URL         (optional, default https://pmsglobal.carestack.com)
 *   CS_IDENTITY_URL     (optional, default https://id.carestack.com)
 * CareStack booking defaults (optional — adapter falls back to first location/provider):
 *   CS_LOCATION_ID CS_PROVIDER_ID CS_OPERATORY_ID CS_APPOINTMENT_TYPE
 * Slack notification (optional):
 *   SLACK_WEBHOOK_URL   SLACK_CHANNEL (optional)
 * Dion federation (optional; null is valid for v1):
 *   DION_PRACTICE_ID
 *
 * Usage:  npx tsx scripts/seed-booking-ehr.ts
 *
 * NOTE: DION_CLINICAL_URL + DION_BUS_SECRET are runtime env (set in Vercel),
 * NOT seeded here.
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { encryptCredentials } from '../src/lib/connectors/crypto'

function req(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`Missing required env: ${name}`)
    process.exit(1)
  }
  return v
}
const opt = (name: string): string | undefined => process.env[name] || undefined

async function main() {
  const orgId = req('BOOKING_ORG_ID')
  const supabase = createClient(req('NEXT_PUBLIC_SUPABASE_URL'), req('SUPABASE_SERVICE_ROLE_KEY'))

  // 1. CareStack connector (write-back + availability). account_id stays plaintext
  //    (webhook route filters on credentials->>account_id); the rest is encrypted.
  if (process.env.CS_CLIENT_ID) {
    const credentials = encryptCredentials({
      account_id: req('CS_ACCOUNT_ID'),
      client_id: req('CS_CLIENT_ID'),
      client_secret: req('CS_CLIENT_SECRET'),
      username: req('CS_USERNAME'),
      password: req('CS_PASSWORD'),
      ...(opt('CS_WEBHOOK_SECRET') ? { webhook_secret: opt('CS_WEBHOOK_SECRET') } : {}),
    })
    const settings = {
      base_url: opt('CS_BASE_URL') || 'https://pmsglobal.carestack.com',
      identity_url: opt('CS_IDENTITY_URL') || 'https://id.carestack.com',
    }
    const { error } = await supabase
      .from('connector_configs')
      .upsert({ organization_id: orgId, connector_type: 'carestack', enabled: true, credentials, settings }, { onConflict: 'organization_id,connector_type' })
    if (error) throw new Error(`carestack: ${error.message}`)
    console.log('✓ carestack connector seeded (enabled)')
  } else {
    console.log('· skipping carestack (CS_CLIENT_ID not set) — CareStack legs stay skipped')
  }

  // 2. Slack connector — SlackConfig lives entirely in credentials (webhookUrl
  //    encrypted; events array passes through).
  if (process.env.SLACK_WEBHOOK_URL) {
    const credentials = encryptCredentials({
      webhookUrl: req('SLACK_WEBHOOK_URL'),
      ...(opt('SLACK_CHANNEL') ? { channel: opt('SLACK_CHANNEL') } : {}),
      events: ['consultation.scheduled', 'consultation.no_show'],
    })
    const { error } = await supabase
      .from('connector_configs')
      .upsert({ organization_id: orgId, connector_type: 'slack', enabled: true, credentials, settings: {} }, { onConflict: 'organization_id,connector_type' })
    if (error) throw new Error(`slack: ${error.message}`)
    console.log('✓ slack connector seeded (consultation.scheduled + no_show)')
  } else {
    console.log('· skipping slack (SLACK_WEBHOOK_URL not set) — no booking Slack card')
  }

  // 3. booking_settings — ensure a row (fixes the "online booking unavailable"
  //    fallback) + CareStack defaults. Select-then-write so we don't depend on an
  //    upsert conflict target; DB defaults fill the rest on insert.
  const csDefaults: Record<string, unknown> = {}
  if (opt('CS_LOCATION_ID')) csDefaults.carestack_location_id = opt('CS_LOCATION_ID')
  if (opt('CS_PROVIDER_ID')) csDefaults.carestack_provider_id = opt('CS_PROVIDER_ID')
  if (opt('CS_OPERATORY_ID')) csDefaults.carestack_operatory_id = opt('CS_OPERATORY_ID')
  if (opt('CS_APPOINTMENT_TYPE')) csDefaults.carestack_appointment_type = opt('CS_APPOINTMENT_TYPE')

  const { data: existingSettings } = await supabase
    .from('booking_settings')
    .select('organization_id')
    .eq('organization_id', orgId)
    .maybeSingle()

  if (existingSettings) {
    const { error } = await supabase
      .from('booking_settings')
      .update({ is_enabled: true, ...csDefaults })
      .eq('organization_id', orgId)
    if (error) throw new Error(`booking_settings update: ${error.message}`)
    console.log('✓ booking_settings updated (is_enabled=true + CareStack defaults)')
  } else {
    const { error } = await supabase
      .from('booking_settings')
      .insert({ organization_id: orgId, is_enabled: true, ...csDefaults })
    if (error) throw new Error(`booking_settings insert: ${error.message}`)
    console.log('✓ booking_settings created (is_enabled=true; schedule/duration use DB defaults — review them)')
  }

  // 4. organizations.dion_practice_id (optional).
  if (opt('DION_PRACTICE_ID')) {
    const { error } = await supabase
      .from('organizations')
      .update({ dion_practice_id: opt('DION_PRACTICE_ID') })
      .eq('id', orgId)
    if (error) throw new Error(`organizations: ${error.message}`)
    console.log('✓ organizations.dion_practice_id set')
  } else {
    console.log('· skipping dion_practice_id — appointment.* will emit dionPracticeId=null (valid for v1)')
  }

  console.log('\nSeed complete for org', orgId)
  console.log('Remaining: set DION_CLINICAL_URL + DION_BUS_SECRET in Vercel, review booking_settings weekly_schedule, then make a test booking.')
}

main().catch((e) => {
  console.error('FAILED:', e?.message ?? e)
  process.exit(1)
})
