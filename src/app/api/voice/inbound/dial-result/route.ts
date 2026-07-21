/**
 * Inbound ring result — the <Dial> action callback for ring-agents mode.
 *
 * Twilio POSTs here when the simultaneous agent ring finishes:
 *   • an agent answered and the call ended → finalize the voice_calls row
 *   • nobody answered (no-answer/busy/failed) → per the org policy, hand the
 *     caller to the AI (inbound_ai_on_no_answer) or take a voicemail.
 *
 * The caller is still live on this request in the no-answer case, so the same
 * "never dead air" rule as /api/voice/inbound applies.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { validateTwilioWebhook } from '@/lib/messaging/twilio'
import {
  buildInboundContext,
  registerRetellCall,
  retellSipTwiml,
  voicemailTwiml,
  sayHangupTwiml,
  hangupTwiml,
} from '@/lib/voice/inbound-flow'

function xml(body: string): NextResponse {
  return new NextResponse(body, { headers: { 'Content-Type': 'text/xml' } })
}

function publicOrigin(req: NextRequest): string {
  const url = new URL(req.url)
  const proto = req.headers.get('x-forwarded-proto') || url.protocol.replace(':', '')
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || url.host
  return `${proto}://${host}`
}

export async function POST(req: NextRequest) {
  let params: Record<string, string>
  try {
    const rawBody = await req.text()
    params = Object.fromEntries(new URLSearchParams(rawBody))
    const twilioSignature = req.headers.get('x-twilio-signature')
    if (process.env.TWILIO_AUTH_TOKEN) {
      if (!twilioSignature || !validateTwilioWebhook(twilioSignature, req.url, params)) {
        return new NextResponse('Invalid Twilio signature', { status: 401 })
      }
    } else if (process.env.NODE_ENV === 'production') {
      return new NextResponse('Voice webhook not configured', { status: 500 })
    }
  } catch {
    return new NextResponse('Bad request', { status: 400 })
  }

  const vcId = req.nextUrl.searchParams.get('vc')
  if (!vcId) return xml(hangupTwiml())

  const supabase = createServiceClient()
  const { data: call } = await supabase
    .from('voice_calls')
    .select('id, organization_id, lead_id, conversation_id, from_number, to_number, metadata')
    .eq('id', vcId)
    .maybeSingle()

  if (!call) {
    console.error('[Voice DialResult] Unknown voice_calls row:', vcId)
    return xml(sayHangupTwiml('Thank you for calling. Goodbye.'))
  }

  const dialStatus = params.DialCallStatus || ''
  const answered = dialStatus === 'completed' || dialStatus === 'answered'
  console.log(`[Voice DialResult] vc=${vcId} DialCallStatus=${dialStatus}`)

  const metadata = (call.metadata as Record<string, unknown>) || {}

  if (answered) {
    // An agent picked up and the conversation already happened (the Dial action
    // fires after the bridged call ends). Finalize the record; a browser-softphone
    // agent enriches this same row with notes + a mandatory disposition, a
    // cell-phone answer stays as-is (outcome null renders as "Needs Review").
    const durationSeconds = Number(params.DialCallDuration) || 0
    const { error } = await supabase
      .from('voice_calls')
      .update({
        status: 'completed',
        ended_at: new Date().toISOString(),
        duration_seconds: durationSeconds,
        metadata: { ...metadata, answered_by: 'agent', dial_call_status: dialStatus, agent_call_sid: params.DialCallSid || null },
      })
      .eq('id', call.id)
    if (error) console.error('[Voice DialResult] finalize failed:', error)

    // Surface the touch on the conversation thread.
    if (call.conversation_id) {
      await supabase
        .from('conversations')
        .update({ last_message_at: new Date().toISOString() })
        .eq('id', call.conversation_id)
    }
    return xml(hangupTwiml())
  }

  // ── Nobody answered — AI takeover or voicemail, per org policy ──
  const { data: org } = await supabase
    .from('organizations')
    .select('*')
    .eq('id', call.organization_id)
    .maybeSingle()

  const origin = publicOrigin(req)
  const practiceName = (org?.name as string) || 'our practice'
  // Active-treatment patient ring (patient=1): the office manager didn't pick up.
  // These callers must NEVER be handed to the sales AI — take a message, and the
  // voicemail route enqueues the Dion Desk hand-off.
  const isPatient = req.nextUrl.searchParams.get('patient') === '1'
  const aiOnNoAnswer = !isPatient && org?.inbound_ai_on_no_answer === true

  await supabase
    .from('voice_calls')
    .update({ metadata: { ...metadata, dial_call_status: dialStatus, ring_result: 'no_answer' } })
    .eq('id', call.id)

  if (isPatient) {
    return xml(voicemailTwiml({
      greeting: `Thank you for calling ${practiceName}. Our office manager isn't available right now. Please leave your name and a brief message, and we'll get right back to you.`,
      practiceName,
      actionUrl: `${origin}/api/voice/inbound/voicemail?vc=${call.id}&patient=1`,
      transcribeCallbackUrl: `${origin}/api/voice/inbound/voicemail?vc=${call.id}&patient=1&kind=transcript`,
    }))
  }

  if (aiOnNoAnswer) {
    // Rebuild the caller context (the lead already exists, so this is a fast
    // lookup) and bridge to Retell against the SAME voice_calls row.
    const ctx = await buildInboundContext(supabase, {
      from: call.from_number || '',
      to: call.to_number || '',
      callerCity: (metadata.caller_city as string) || '',
      callerState: (metadata.caller_state as string) || '',
    })
    const retellCallId = await registerRetellCall({
      from: call.from_number || '',
      to: call.to_number || '',
      twilioCallSid: (metadata.twilio_call_sid as string) || '',
      dynamicVariables: { ...ctx.dynamicVariables, after_agent_ring: 'true' },
      metadata: {
        lead_id: call.lead_id,
        organization_id: call.organization_id,
        conversation_id: call.conversation_id,
      },
    })
    if (retellCallId) {
      await supabase
        .from('voice_calls')
        .update({ retell_call_id: retellCallId, status: 'ringing' })
        .eq('id', call.id)
      return xml(retellSipTwiml(retellCallId))
    }
    // Retell down → voicemail is the only remaining net.
  }

  return xml(voicemailTwiml({
    greeting: (org?.inbound_voicemail_greeting as string | null) || null,
    practiceName,
    actionUrl: `${origin}/api/voice/inbound/voicemail?vc=${call.id}`,
    transcribeCallbackUrl: `${origin}/api/voice/inbound/voicemail?vc=${call.id}&kind=transcript`,
  }))
}
