/**
 * QA: send an AI-generated lead-QUALIFICATION opener SMS to the Amin test lead,
 * through the real, fully-gated `sendSMSToLead` path (aiGenerated=true so the
 * compliance filter runs). Same gate chain the inbound webhook + autopilot use:
 * campaign auth → consent (TCPA) → compliance → quiet-hours → US A2P 10DLC gate
 * (us_sms_enabled) → verified Messaging Service.
 *
 * A { sent: true } result means every gate passed and a real qualification text
 * reached +14156767420. { sent:false, reason } means a gate blocked it (most
 * likely the A2P us_sms_enabled flag still being off) — nothing leaves the system.
 *
 * Hard-safe: the lowest choke point in twilio.ts refuses any recipient not on
 * TEST_SEND_ALLOWLIST, so this cannot reach a real patient.
 *
 * Usage: npx tsx scripts/test-qualification-sms-amin.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import { sendSMSToLead } from '../src/lib/messaging/twilio'

const ORG_ID = 'fa64e53c-3d9b-493e-b904-59580cb3f29c' // Dion Health San Francisco
const LEAD_ID = '62e839ba-90ea-4e77-bcb8-68d5172a2e6b' // Amin Samadian test lead
const TO = '+14156767420'

async function generateQualificationOpener(firstName: string): Promise<string> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 200,
    messages: [
      {
        role: 'user',
        content:
          `Write ONE outbound SMS (max 300 characters) that opens the lead-qualification ` +
          `conversation for a new dental patient inquiry at Dion Health in San Francisco. ` +
          `The lead's first name is "${firstName}". Requirements: warm and human; identify ` +
          `the sender as "Dion Health"; ask exactly ONE qualifying question to understand ` +
          `what they're looking for (e.g. single-tooth implant vs. full-arch, or their main ` +
          `concern); end with "Reply STOP to opt out." Output ONLY the SMS text, no quotes, ` +
          `no preamble.`,
      },
    ],
  })
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
  if (!text) throw new Error('Model returned empty message')
  return text
}

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: lead, error } = await supabase
    .from('leads')
    .select('id, first_name, last_name, sms_consent')
    .eq('id', LEAD_ID)
    .single()
  if (error || !lead) throw new Error(`Lead not found: ${error?.message}`)
  console.log('Lead:', lead.first_name, lead.last_name, '· sms_consent:', lead.sms_consent)

  const body = await generateQualificationOpener(lead.first_name || 'there')
  console.log('\nAI qualification opener:\n ', body, `\n  (${body.length} chars)\n`)

  const result = await sendSMSToLead({
    supabase,
    leadId: LEAD_ID,
    to: TO,
    body,
    caller: 'qualification_test',
    aiGenerated: true, // activates the compliance filter
    bypassQuietHours: true, // 1:1, owner-requested test send
  })

  console.log('sendSMSToLead result:', JSON.stringify(result))

  if (result.sent) {
    await supabase.from('lead_activities').insert({
      organization_id: ORG_ID,
      lead_id: LEAD_ID,
      activity_type: 'sms_sent',
      title: 'AI qualification opener (test)',
      description: `AI qualification SMS via sendSMSToLead. sid=${result.sid} status=${result.status}. Body: ${body}`,
    })
    console.log('\n✅ SENT — logged sms_sent activity. Reply from your phone to exercise the inbound AI loop.')
  } else {
    console.log('\n⛔ NOT SENT — reason:', result.reason)
    console.log('   (If reason is the A2P gate, flip us_sms_enabled on for the org once 10DLC is verified, then re-run.)')
    process.exit(2)
  }
}

main().catch((e) => {
  console.error('FAILED:', e?.message ?? e)
  process.exit(1)
})
