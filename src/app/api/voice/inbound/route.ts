import { NextRequest, NextResponse } from 'next/server'
import { validateTwilioWebhook } from '@/lib/messaging/twilio'
import {
  buildInboundContext,
  resolveInboundRingPlan,
  registerRetellCall,
  retellSipTwiml,
  ringAgentsTwiml,
  voicemailTwiml,
  sayHangupTwiml,
  twimlResponse,
  type InboundContext,
} from '@/lib/voice/inbound-flow'

/**
 * Twilio Voice Webhook — Inbound Call Handler
 *
 * When someone calls the practice's Twilio number, this webhook decides who
 * answers, per the org's inbound policy (organizations.inbound_call_mode):
 *
 *   'ai' (default)   → register with Retell and bridge immediately — the AI
 *                      answers every call (previous behavior, unchanged).
 *   'ring_agents'    → ring the practice's live targets (phones + browser
 *                      softphones, from the live-transfer config) first:
 *        in hours, nobody answers → AI takes over (inbound_ai_on_no_answer)
 *                                   or voicemail (manual process)
 *        out of hours             → AI answers (inbound_ai_after_hours)
 *                                   or voicemail
 *
 * CRITICAL: This webhook MUST return TwiML quickly. All DB operations are
 * failure-tolerant so they never block the call connection, and every branch
 * ends in SOME answer path — never dead air.
 */

function getSupabase() {
  try {
    const { createClient } = require('@supabase/supabase-js')
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) {
      console.error('[Voice Inbound] Missing Supabase env vars')
      return null
    }
    return createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  } catch (e) {
    console.error('[Voice Inbound] Failed to create Supabase client:', e)
    return null
  }
}

/** The public origin Twilio should hit for follow-up callbacks (proxy-aware). */
function publicOrigin(req: NextRequest): string {
  const url = new URL(req.url)
  const proto = req.headers.get('x-forwarded-proto') || url.protocol.replace(':', '')
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || url.host
  return `${proto}://${host}`
}

function xml(body: string): NextResponse {
  return new NextResponse(body, { headers: { 'Content-Type': 'text/xml' } })
}

/**
 * AI answer path: register with Retell, persist/update the voice_calls row, and
 * bridge over SIP. `existingCallId` updates a row the ring path already created
 * instead of inserting a second one. Falls back to voicemail TwiML if Retell is
 * down (the caller must never hear dead air).
 */
async function answerWithAI(
  supabase: ReturnType<typeof getSupabase>,
  ctx: InboundContext,
  params: {
    from: string
    to: string
    callSid: string
    callerCity: string
    callerState: string
    callerCountry: string
    existingCallId?: string
    origin: string
  }
): Promise<NextResponse> {
  const { from, to, callSid, existingCallId, origin } = params

  const retellCallId = await registerRetellCall({
    from,
    to,
    twilioCallSid: callSid,
    dynamicVariables: ctx.dynamicVariables,
    metadata: {
      lead_id: ctx.leadId,
      organization_id: ctx.orgId,
      conversation_id: ctx.conversationId,
    },
  })

  if (!retellCallId) {
    // Retell down → apologize and take a message. When the ring path already
    // created a row we route the recording through the voicemail callback so it
    // still lands on the call record; otherwise keep the legacy bare <Record>.
    if (existingCallId) {
      return xml(voicemailTwiml({
        greeting: `We're sorry, we can't take your call right now. Please leave a message after the beep and we'll get back to you.`,
        practiceName: ctx.practiceName,
        actionUrl: `${origin}/api/voice/inbound/voicemail?vc=${existingCallId}`,
        transcribeCallbackUrl: `${origin}/api/voice/inbound/voicemail?vc=${existingCallId}&kind=transcript`,
      }))
    }
    return xml(twimlResponse(
      `\n  <Say>We're sorry, our AI assistant is temporarily unavailable. Please try again later or leave a message after the beep.</Say>\n  <Record maxLength="120" transcribe="true" />\n`
    ))
  }

  console.log(`[Voice Inbound] Retell call registered: ${retellCallId}`)

  // Log/update the call record (fire-and-forget — must not delay the bridge).
  if (supabase && ctx.orgId && ctx.leadId) {
    const write = existingCallId
      ? supabase.from('voice_calls').update({
          retell_call_id: retellCallId,
          status: 'ringing',
        }).eq('id', existingCallId)
      : supabase.from('voice_calls').insert({
          organization_id: ctx.orgId,
          lead_id: ctx.leadId,
          conversation_id: ctx.conversationId,
          direction: 'inbound',
          status: 'ringing',
          retell_call_id: retellCallId,
          from_number: from,
          to_number: to,
          started_at: new Date().toISOString(),
          consent_verified: true,
          metadata: {
            twilio_call_sid: callSid,
            caller_city: params.callerCity,
            caller_state: params.callerState,
            caller_country: params.callerCountry,
          },
        })
    write.then(({ error }: { error: unknown }) => {
      if (error) console.error('[Voice Inbound] Failed to log call:', error)
    })
  }

  return xml(retellSipTwiml(retellCallId))
}

export async function POST(req: NextRequest) {
  // Validate the Twilio signature over the raw form body BEFORE trusting any
  // field — otherwise anyone can forge an inbound call, plant a consented lead,
  // and burn Retell minutes. Mirrors the SMS webhook. Mandatory in production.
  let from = '', to = '', callSid = '', callerCity = '', callerState = '', callerCountry = '', callerName = ''
  try {
    const rawBody = await req.text()
    const params = Object.fromEntries(new URLSearchParams(rawBody))
    const twilioSignature = req.headers.get('x-twilio-signature')
    if (process.env.TWILIO_AUTH_TOKEN) {
      if (!twilioSignature || !validateTwilioWebhook(twilioSignature, req.url, params)) {
        return new NextResponse('Invalid Twilio signature', { status: 401 })
      }
    } else if (process.env.NODE_ENV === 'production') {
      // No auth token configured in prod = cannot verify = reject (fail closed).
      return new NextResponse('Voice webhook not configured', { status: 500 })
    }
    from = params.From || ''
    to = params.To || ''
    callSid = params.CallSid || ''
    callerCity = params.CallerCity || ''
    callerState = params.CallerState || ''
    callerCountry = params.CallerCountry || ''
    callerName = params.CallerName || ''
  } catch (e) {
    console.error('[Voice Inbound] Failed to parse/validate form data:', e)
    return new NextResponse('Bad request', { status: 400 })
  }

  console.log(`[Voice Inbound] Call from ${from} to ${to}, SID: ${callSid}`)

  const supabase = getSupabase()
  const ctx = await buildInboundContext(supabase, { from, to, callerCity, callerState, callerName })
  const origin = publicOrigin(req)
  const aiParams = { from, to, callSid, callerCity, callerState, callerCountry, origin }

  try {
    // ── Ring-agents mode ──
    // Requires full attribution (org + lead) so the follow-up webhooks can act on
    // a concrete voice_calls row; anything less degrades to the AI path, which
    // handles unattributed calls gracefully.
    if (ctx.settings.mode === 'ring_agents' && supabase && ctx.orgId && ctx.leadId) {
      const plan = await resolveInboundRingPlan(supabase, ctx.orgId)

      // The ring path needs its call row up front: the <Dial>/<Record> callbacks
      // reference it by id. Insert is awaited (single small write).
      const { data: callRow, error: insertError } = await supabase
        .from('voice_calls')
        .insert({
          organization_id: ctx.orgId,
          lead_id: ctx.leadId,
          conversation_id: ctx.conversationId,
          direction: 'inbound',
          status: 'ringing',
          from_number: from,
          to_number: to,
          started_at: new Date().toISOString(),
          consent_verified: true,
          // Top-level SID (not just metadata) so the voice-reconcile cron can
          // query Twilio and self-heal this row if the Dial/Record callbacks
          // never arrive.
          twilio_call_sid: callSid,
          metadata: {
            twilio_call_sid: callSid,
            caller_city: callerCity,
            caller_state: callerState,
            caller_country: callerCountry,
            inbound_handling: plan.inHours ? 'ring_agents' : 'after_hours',
          },
        })
        .select('id')
        .single()

      if (insertError || !callRow) {
        console.error('[Voice Inbound] Ring-mode call insert failed, degrading to AI:', insertError)
        return await answerWithAI(supabase, ctx, aiParams)
      }
      const vcId = callRow.id as string

      const voicemail = () => xml(voicemailTwiml({
        greeting: ctx.settings.voicemailGreeting,
        practiceName: ctx.practiceName,
        actionUrl: `${origin}/api/voice/inbound/voicemail?vc=${vcId}`,
        transcribeCallbackUrl: `${origin}/api/voice/inbound/voicemail?vc=${vcId}&kind=transcript`,
      }))

      if (!plan.inHours) {
        // Outside every routing window: AI covers the night shift if enabled,
        // otherwise straight to voicemail (agents aren't there to ring).
        return ctx.settings.aiAfterHours
          ? await answerWithAI(supabase, ctx, { ...aiParams, existingCallId: vcId })
          : voicemail()
      }

      if (plan.targets.length === 0) {
        // Open, but nobody to ring (no targets configured / all off-duty) —
        // same policy as an unanswered ring.
        return ctx.settings.aiOnNoAnswer
          ? await answerWithAI(supabase, ctx, { ...aiParams, existingCallId: vcId })
          : voicemail()
      }

      const leadName = ctx.dynamicVariables.caller_full_name || 'Caller'
      return xml(ringAgentsTwiml({
        targets: plan.targets,
        ringSeconds: ctx.settings.ringSeconds,
        actionUrl: `${origin}/api/voice/inbound/dial-result?vc=${vcId}`,
        voiceCallId: vcId,
        leadId: ctx.leadId,
        leadName,
        greeting: ctx.settings.greeting,
      }))
    }

    // ── AI mode (default) ──
    return await answerWithAI(supabase, ctx, aiParams)
  } catch (error) {
    console.error('[Voice Inbound] Fatal error:', error)
    return xml(sayHangupTwiml("We're sorry, an error occurred. Please try again later."))
  }
}

// Twilio also sends GET for webhook validation
export async function GET() {
  return new NextResponse(
    `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>This is the Lead Intelligence AI voice system.</Say>
</Response>`,
    { headers: { 'Content-Type': 'text/xml' } }
  )
}
