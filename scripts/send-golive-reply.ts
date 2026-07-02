/**
 * One-off: send a reply to Amin's lead through the GATED app path (sendSMSToLead),
 * to prove the us_sms_enabled flag flip opened the send path end-to-end.
 *
 * This is the same function the inbound webhook / autopilot use — it enforces
 * consent → compliance → TCPA quiet-hours → the US 10DLC us_sms_enabled gate,
 * then sends via the verified Messaging Service. A { sent: true } result means
 * every gate passed. Also logs an sms_sent activity so the CRM feed is accurate.
 *
 * Usage: npx tsx scripts/send-golive-reply.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { sendSMSToLead } from '../src/lib/messaging/twilio'

const ORG_ID = 'fa64e53c-3d9b-493e-b904-59580cb3f29c' // Dion Health San Francisco
const LEAD_ID = '62e839ba-90ea-4e77-bcb8-68d5172a2e6b'
const TO = '+14156767420'
const BODY =
  "Dion Health here — got your message loud and clear. Two-way texting through Lead Intelligence is now live. Reply STOP to opt out, HELP for help."

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const result = await sendSMSToLead({
    supabase,
    leadId: LEAD_ID,
    to: TO,
    body: BODY,
    caller: 'go_live_test',
    bypassQuietHours: true, // 1:1 customer-initiated reply
  })

  console.log('sendSMSToLead result:', JSON.stringify(result))

  if (result.sent) {
    await supabase.from('lead_activities').insert({
      organization_id: ORG_ID,
      lead_id: LEAD_ID,
      activity_type: 'sms_sent',
      title: 'Go-live reply (app send path)',
      description: `Sent via sendSMSToLead after us_sms_enabled flip. sid=${result.sid} status=${result.status}. Body: ${BODY}`,
    })
    console.log('Logged sms_sent activity.')
  } else {
    console.log('NOT SENT — reason:', result.reason)
    process.exit(2)
  }
}

main().catch((e) => {
  console.error('FAILED:', e?.message ?? e)
  process.exit(1)
})
