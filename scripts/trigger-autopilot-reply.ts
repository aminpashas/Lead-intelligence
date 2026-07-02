/**
 * One-off: run the autopilot auto-responder on-demand for Amin's pending inbound
 * ("I need implants"), so we can see the real AI reply without re-texting.
 *
 * Invokes the SAME processAutoResponse the inbound webhook calls. With the org in
 * enabled+paused mode and this lead's ai_autopilot_override='force_on', autopilot
 * runs for this lead only. The AI decides send vs. escalate per its confidence
 * threshold; if it sends, it goes out via the verified Messaging Service.
 *
 * Usage: npx tsx scripts/trigger-autopilot-reply.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { processAutoResponse } from '../src/lib/autopilot/auto-respond'

const ORG_ID = 'fa64e53c-3d9b-493e-b904-59580cb3f29c'
const LEAD_ID = '62e839ba-90ea-4e77-bcb8-68d5172a2e6b'
const INBOUND = 'I need implants'
const SENDER = '+14156767420'

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: lead } = await supabase
    .from('leads')
    .select('*, organization_id')
    .eq('id', LEAD_ID)
    .single()

  const { data: conversation } = await supabase
    .from('conversations')
    .select('*')
    .eq('lead_id', LEAD_ID)
    .eq('channel', 'sms')
    .eq('status', 'active')
    .single()

  if (!lead || !conversation) throw new Error('lead or conversation not found')

  console.log('lead.ai_autopilot_override:', lead.ai_autopilot_override)
  console.log('conversation.ai_mode:', conversation.ai_mode, '| ai_enabled:', conversation.ai_enabled)

  const result = await processAutoResponse(supabase, {
    organization_id: ORG_ID,
    conversation_id: conversation.id,
    lead_id: LEAD_ID,
    lead,
    conversation,
    inbound_message: INBOUND,
    channel: 'sms',
    sender_contact: SENDER,
  })

  console.log('\n=== processAutoResponse result ===')
  console.log(JSON.stringify(result, null, 2))
}

main().catch((e) => {
  console.error('FAILED:', e?.stack ?? e?.message ?? e)
  process.exit(1)
})
