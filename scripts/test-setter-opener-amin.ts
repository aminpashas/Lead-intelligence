/**
 * QA: send the DEFAULT SETTER opener SMS to the Amin test lead through the real,
 * fully-gated `sendSMSToLead` path (aiGenerated=true so the compliance filter runs).
 *
 * This exercises the DEFAULT booking workflow ONLY — get chief concern + history,
 * steer toward booking a free consultation. It must NOT pitch financing; the
 * financing/qualification soft-pull is a SEPARATE, button-triggered workflow.
 *
 * On success it also seeds the opener as an outbound `ai` message on the given
 * (fresh) SMS conversation so the inbound reply loop has coherent history:
 *   [opener] -> your reply -> Setter default flow.
 *
 * Usage: npx tsx scripts/test-setter-opener-amin.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import { sendSMSToLead } from '../src/lib/messaging/twilio'

const ORG_ID = 'fa64e53c-3d9b-493e-b904-59580cb3f29c' // Dion Health San Francisco
const LEAD_ID = '62e839ba-90ea-4e77-bcb8-68d5172a2e6b' // Amin Samadian test lead
const CONVERSATION_ID = 'fe43feea-d282-40a9-b8ed-fd1a72942709' // fresh SMS thread
const TO = '+14156767420'

async function generateSetterOpener(firstName: string): Promise<string> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 200,
    messages: [
      {
        role: 'user',
        content:
          `Write ONE outbound SMS (max 300 characters) that opens the conversation for a ` +
          `new dental patient inquiry at Dion Health in San Francisco. The lead's first ` +
          `name is "${firstName}". Requirements: warm and human; identify the sender as ` +
          `"Dion Health"; ask exactly ONE open question about their main concern / what's ` +
          `going on with their teeth (so we understand what they need). Do NOT mention ` +
          `money, cost, financing, credit, payments, or "$0 down" at all. End with ` +
          `"Reply STOP to opt out." Output ONLY the SMS text, no quotes, no preamble.`,
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
    .select('id, first_name, last_name, sms_consent, status')
    .eq('id', LEAD_ID)
    .single()
  if (error || !lead) throw new Error(`Lead not found: ${error?.message}`)
  console.log('Lead:', lead.first_name, lead.last_name, '· status:', lead.status, '· sms_consent:', lead.sms_consent)

  const body = await generateSetterOpener(lead.first_name || 'there')
  console.log('\nSetter opener:\n ', body, `\n  (${body.length} chars)\n`)

  const result = await sendSMSToLead({
    supabase,
    leadId: LEAD_ID,
    to: TO,
    body,
    caller: 'setter_test',
    aiGenerated: true, // activates the compliance filter
    bypassQuietHours: true, // 1:1, owner-requested test send
  })

  console.log('sendSMSToLead result:', JSON.stringify(result))

  if (result.sent) {
    // Seed the opener into the fresh conversation so inbound replies thread cleanly.
    await supabase.from('messages').insert({
      organization_id: ORG_ID,
      conversation_id: CONVERSATION_ID,
      lead_id: LEAD_ID,
      direction: 'outbound',
      channel: 'sms',
      body,
      sender_type: 'ai',
      status: 'sent',
      external_id: result.sid || null,
      ai_generated: true,
      metadata: { agent: 'setter', test: true, opener: true },
    })
    await supabase
      .from('conversations')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', CONVERSATION_ID)
    await supabase.from('lead_activities').insert({
      organization_id: ORG_ID,
      lead_id: LEAD_ID,
      activity_type: 'sms_sent',
      title: 'Setter opener (test)',
      description: `Default-flow Setter opener via sendSMSToLead. sid=${result.sid} status=${result.status}. Body: ${body}`,
    })
    console.log('\n✅ SENT + seeded into conversation', CONVERSATION_ID, '— reply from your phone to exercise the Setter default flow.')
  } else {
    console.log('\n⛔ NOT SENT — reason:', result.reason)
    process.exit(2)
  }
}

main().catch((e) => {
  console.error('FAILED:', e?.message ?? e)
  process.exit(1)
})
