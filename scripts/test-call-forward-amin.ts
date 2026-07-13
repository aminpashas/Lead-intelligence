/**
 * Call-and-forward test — "the app calls the lead, on pickup forwards to the agent",
 * AND logs the call on the lead like a real app-placed call.
 *
 * This is the SIMPLE (Path B) version of the live-transfer workflow: raw Twilio,
 * no Retell AI in the middle. It stands in for the eventual AI-mediated transfer
 * broker (/api/voice/transfer) while that path's Retell config isn't wired.
 *
 * What it does, in order:
 *   1. Look up the lead (default: Amin) → org, caller ID.
 *   2. Find/create the lead's active voice conversation.
 *   3. Insert a `voice_calls` row (status=initiated) + a timeline marker, so the
 *      call shows on the lead IMMEDIATELY — not just after it ends.
 *   4. Place the Twilio call to the lead. On pickup the TwiML plays the campaign
 *      greeting, then <Dial>s the agent's cell and bridges.
 *   5. Point Twilio's statusCallback at {APP_URL}/api/voice/status?voiceCallId=...
 *      so ringing → answered → completed (with duration) land on the SAME row and
 *      write the `voice_call_completed` activity — exactly like a browser call.
 *
 * Note: a plain <Dial> forward has NO transcript, so there's no AI call *summary*
 * (those come from the Retell path). Set RECORD=1 to capture a recording_url.
 *
 * Usage:
 *   npx tsx scripts/test-call-forward-amin.ts [leadNumber] [agentNumber] [campaign]
 * Env overrides:
 *   LEAD_ID=<uuid>   RECORD=1
 */
// Secrets live in .env.local (not .env), so load that explicitly.
import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
import { getPublicAppUrl } from '../src/lib/app-url'

const LEAD_NUMBER = process.argv[2] || '+14156767420' // Amin (test lead)
const AGENT_NUMBER = process.argv[3] || '+18058889879' // Heather (agent cell)
const CAMPAIGN = (process.argv[4] || 'implant').toLowerCase()
const LEAD_ID = process.env.LEAD_ID || '62e839ba-90ea-4e77-bcb8-68d5172a2e6b' // Amin Samadian
const RECORD = process.env.RECORD === '1'

// Per-campaign line the lead hears on pickup, before the forward bridges.
const CAMPAIGN_GREETINGS: Record<string, string> = {
  implant: "Hi, I'm calling from Dion Health. Transferring you to our team now, one moment.",
}
const greeting = CAMPAIGN_GREETINGS[CAMPAIGN] || CAMPAIGN_GREETINGS.implant

async function main() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken = process.env.TWILIO_AUTH_TOKEN
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!accountSid || !authToken) {
    console.error('❌ Missing Twilio env (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)')
    process.exit(1)
  }
  if (!supabaseUrl || !serviceKey) {
    console.error('❌ Missing Supabase env (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)')
    process.exit(1)
  }

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  // 1. Lead → org + caller ID.
  const { data: lead, error: leadErr } = await supabase
    .from('leads')
    .select('id, first_name, organization_id')
    .eq('id', LEAD_ID)
    .single()
  if (leadErr || !lead) {
    console.error(`❌ Lead ${LEAD_ID} not found: ${leadErr?.message}`)
    process.exit(1)
  }
  const orgId = lead.organization_id as string

  const { data: org } = await supabase
    .from('organizations')
    .select('voice_outbound_caller_id')
    .eq('id', orgId)
    .single()
  const fromNumber = (org?.voice_outbound_caller_id as string) || process.env.TWILIO_PHONE_NUMBER
  if (!fromNumber) {
    console.error('❌ No outbound caller ID (org.voice_outbound_caller_id / TWILIO_PHONE_NUMBER)')
    process.exit(1)
  }

  console.log('📞 Call-and-forward test (logs on lead)')
  console.log('─'.repeat(56))
  console.log(`Lead:         ${lead.first_name} (${LEAD_NUMBER})  [${LEAD_ID}]`)
  console.log(`Agent:        ${AGENT_NUMBER}  (forwarded to on pickup)`)
  console.log(`From (CID):   ${fromNumber}`)
  console.log(`Campaign:     ${CAMPAIGN}`)
  console.log(`Greeting:     "${greeting}"`)
  console.log(`Recording:    ${RECORD ? 'on' : 'off'}`)
  console.log('─'.repeat(56))

  // 2. Find/create the active voice conversation for this lead.
  let conversationId: string | null = null
  const { data: convo } = await supabase
    .from('conversations')
    .select('id')
    .eq('lead_id', LEAD_ID)
    .eq('channel', 'voice')
    .eq('status', 'active')
    .limit(1)
    .maybeSingle()
  if (convo?.id) {
    conversationId = convo.id as string
  } else {
    const { data: created } = await supabase
      .from('conversations')
      .insert({
        organization_id: orgId,
        lead_id: LEAD_ID,
        channel: 'voice',
        status: 'active',
        ai_enabled: false,
        ai_mode: 'off',
      })
      .select('id')
      .single()
    conversationId = (created?.id as string) || null
  }

  // 3. Insert the voice_calls row up front so the call is visible immediately.
  const { data: callRow, error: callErr } = await supabase
    .from('voice_calls')
    .insert({
      organization_id: orgId,
      lead_id: LEAD_ID,
      conversation_id: conversationId,
      direction: 'outbound',
      status: 'initiated',
      call_mode: 'ai', // system-placed (not a browser/bridge staff call)
      agent_type: 'none',
      from_number: fromNumber,
      to_number: LEAD_NUMBER,
      consent_verified: true,
      tcpa_compliant: true,
      recording_disclosure_given: RECORD,
      metadata: { test: true, forward_to: AGENT_NUMBER, campaign: CAMPAIGN },
    })
    .select('id')
    .single()
  if (callErr || !callRow) {
    console.error(`❌ Failed to insert voice_calls row: ${callErr?.message}`)
    process.exit(1)
  }
  const voiceCallId = callRow.id as string
  console.log(`🗂  voice_calls row: ${voiceCallId}`)

  // Timeline marker + activity so it shows on the lead right away.
  await supabase.from('lead_activities').insert({
    organization_id: orgId,
    lead_id: LEAD_ID,
    activity_type: 'voice_call_initiated',
    title: `Outbound call — ${CAMPAIGN} campaign (forwarding to agent)`,
    metadata: { call_id: voiceCallId, campaign: CAMPAIGN, forward_to: AGENT_NUMBER, test: true },
  })
  if (conversationId) {
    await supabase.from('messages').insert({
      organization_id: orgId,
      conversation_id: conversationId,
      lead_id: LEAD_ID,
      direction: 'outbound',
      channel: 'voice',
      body: `📞 Outbound call placed — ${CAMPAIGN} campaign. Forwarding to the team.`,
      sender_type: 'ai',
      status: 'sent',
      ai_generated: true,
      metadata: { voice_call_id: voiceCallId, test: true },
    })
  }

  // 4/5. Place the Twilio call, pointing the statusCallback at our /api/voice/status
  // (?voiceCallId= matches the row; Twilio signs the full URL, the route validates it).
  const statusCb = `${getPublicAppUrl()}/api/voice/status?voiceCallId=${voiceCallId}`
  const recordAttr = RECORD
    ? ` record="record-from-answer" recordingStatusCallback="${statusCb}" recordingStatusCallbackMethod="POST"`
    : ''
  const twiml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Say voice="Polly.Joanna">${greeting}</Say>` +
    `<Dial answerOnBridge="true" callerId="${fromNumber}" timeout="25"${recordAttr}>${AGENT_NUMBER}</Dial>` +
    `</Response>`

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`
  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64')
  const body = new URLSearchParams({
    To: LEAD_NUMBER,
    From: fromNumber,
    Twiml: twiml,
    StatusCallback: statusCb,
    StatusCallbackMethod: 'POST',
  })
  // URLSearchParams collapses repeated keys, so append each event separately.
  for (const ev of ['initiated', 'ringing', 'answered', 'completed']) body.append('StatusCallbackEvent', ev)

  try {
    console.log('\n⏳ Placing outbound call to the lead…')
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    })
    const data = await response.json()

    if (!response.ok) {
      console.error('\n❌ Failed to place call')
      console.error(`   Error Code:    ${data.code}`)
      console.error(`   Error Message: ${data.message}`)
      await supabase.from('voice_calls').update({ status: 'failed', outcome_notes: data.message }).eq('id', voiceCallId)
      process.exit(1)
    }

    // Store the Twilio SID on the row (also lets the status route match by SID as a fallback).
    await supabase
      .from('voice_calls')
      .update({ twilio_call_sid: data.sid, status: 'ringing', started_at: new Date().toISOString() })
      .eq('id', voiceCallId)

    console.log('\n✅ Call initiated & logged on the lead!')
    console.log(`   Twilio SID:   ${data.sid}`)
    console.log(`   voiceCallId:  ${voiceCallId}`)
    console.log(`   statusCb:     ${statusCb}`)
    console.log('\n👉 Answer on the lead line — greeting plays, then the agent rings.')
    console.log('   Lifecycle (answered/duration) lands via the statusCallback as the call ends.')
  } catch (err) {
    console.error('\n❌ Network error:', err instanceof Error ? err.message : err)
    await supabase.from('voice_calls').update({ status: 'failed' }).eq('id', voiceCallId)
    process.exit(1)
  }
}

main()
