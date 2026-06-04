import { NextRequest, NextResponse } from 'next/server'
import { validateTwilioWebhook } from '@/lib/messaging/twilio'

/**
 * Twilio Voice Webhook — Inbound Call Handler
 *
 * When someone calls your Twilio number:
 * 1. Twilio hits this webhook with caller info
 * 2. We register the call with Retell (ALWAYS — even if DB fails)
 * 3. We attempt to look up / create lead info (non-blocking)
 * 4. We return TwiML that dials the Retell SIP address
 *
 * CRITICAL: This webhook MUST return TwiML quickly. All DB operations
 * are wrapped in try/catch so they never block the call connection.
 */

const RETELL_API_KEY = process.env.RETELL_API_KEY || ''
const RETELL_AGENT_ID = 'agent_d5891af66aa9f7a83b9f96fc3a'

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

  // ── 1. Attempt DB lookups (non-blocking — wrapped in try/catch) ──
  let practiceName = 'our practice'
  let dynamicVariables: Record<string, string> = {
    caller_phone: from,
    caller_full_name: 'the caller',
    caller_first_name: '',
    caller_last_name: '',
    caller_location: [callerCity, callerState].filter(Boolean).join(', ') || 'unknown',
    lead_status: 'unknown',
    lead_score: '0',  // maps from ai_score internally
    lead_source: 'unknown',
    lead_notes: '',
    is_new_lead: 'true',
    is_returning: 'false',
    practice_name: practiceName,
    personality_type: '',
    communication_style: '',
  }
  let leadId: string | null = null
  let orgId: string | null = null
  let conversationId: string | null = null

  const supabase = getSupabase()
  if (supabase) {
    try {
      // ── Get the organization ──
      const { data: org } = await supabase
        .from('organizations')
        .select('id, name, voice_greeting')
        .eq('voice_outbound_caller_id', to)
        .single()

      if (org) {
        orgId = org.id
        practiceName = org.name || 'our practice'
      } else {
        // Fallback only when genuinely single-tenant. Guessing "first org" in a
        // multi-tenant deployment would attribute a call (and any created lead /
        // PHI) to the wrong tenant.
        const { data: orgs } = await supabase
          .from('organizations')
          .select('id, name, voice_greeting')
          .limit(2)
        if (orgs && orgs.length === 1) {
          orgId = orgs[0].id
          practiceName = orgs[0].name || 'our practice'
          console.log(`[Voice Inbound] Single-tenant org fallback: ${orgs[0].name}`)
        } else {
          console.warn(`[Voice Inbound] No org matched caller-id ${to} and deployment is multi-tenant — not attributing call`)
        }
      }

      // ── Look up the caller ──
      if (orgId) {
        const normalizedPhone = from.replace(/^\+1/, '').replace(/\D/g, '')
        const phoneVariants = [
          from,
          normalizedPhone,
          `+1${normalizedPhone}`,
          `(${normalizedPhone.slice(0,3)}) ${normalizedPhone.slice(3,6)}-${normalizedPhone.slice(6)}`,
        ]

        const { data: existingLead } = await supabase
          .from('leads')
          .select('id, first_name, last_name, email, phone, status, ai_score, notes, source_type, personality_profile')
          .eq('organization_id', orgId)
          .or([
            ...phoneVariants.map(p => `phone.eq.${p}`),
            ...phoneVariants.map(p => `phone_formatted.eq.${p}`),
          ].join(','))
          .limit(1)
          .single()

        let lead = existingLead
        let isNewLead = false

        if (!lead) {
          // Auto-create lead
          const displayName = callerName || `Caller ${normalizedPhone.slice(-4)}`
          const nameParts = displayName.split(' ')
          const { data: newLead } = await supabase
            .from('leads')
            .insert({
              organization_id: orgId,
              first_name: nameParts[0] || 'Unknown',
              last_name: nameParts.slice(1).join(' ') || 'Caller',
              phone: from,
              phone_formatted: from,
              source_type: 'inbound_call',
              status: 'new',
              ai_score: 50,
              notes: `Auto-created from inbound call on ${new Date().toLocaleDateString()}. ${callerCity ? `Location: ${callerCity}, ${callerState}` : ''}`.trim(),
              voice_consent: true,
              voice_consent_at: new Date().toISOString(),
              voice_consent_source: 'inbound_call',
            })
            .select()
            .single()

          if (newLead) {
            lead = newLead
            isNewLead = true
            console.log(`[Voice Inbound] Created lead: ${newLead.id}`)
          }
        } else {
          console.log(`[Voice Inbound] Found lead: ${lead.first_name} ${lead.last_name}`)
        }

        if (lead) {
          leadId = lead.id
          const personality = lead.personality_profile as Record<string, unknown> | null
          dynamicVariables = {
            caller_phone: from,
            caller_first_name: lead.first_name || '',
            caller_last_name: lead.last_name || '',
            caller_full_name: `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || 'the caller',
            caller_location: [callerCity, callerState].filter(Boolean).join(', ') || 'unknown',
            lead_status: lead.status || 'unknown',
            lead_score: String(lead.ai_score || 0),
            lead_source: lead.source_type || 'unknown',
            lead_notes: (lead.notes || '').slice(0, 500),
            is_new_lead: String(isNewLead),
            is_returning: String(!isNewLead),
            practice_name: practiceName,
            personality_type: (personality?.type as string) || '',
            communication_style: (personality?.communication_style as string) || '',
          }

          // Create/find conversation
          try {
            const { data: conv } = await supabase
              .from('conversations')
              .select('id')
              .eq('organization_id', orgId)
              .eq('lead_id', lead.id)
              .eq('channel', 'voice')
              .order('created_at', { ascending: false })
              .limit(1)
              .single()

            if (conv) {
              conversationId = conv.id
            } else {
              const { data: newConv } = await supabase
                .from('conversations')
                .insert({
                  organization_id: orgId,
                  lead_id: lead.id,
                  channel: 'voice',
                  status: 'open',
                  ai_enabled: true,
                  last_message_at: new Date().toISOString(),
                })
                .select('id')
                .single()
              conversationId = newConv?.id || null
            }
          } catch (convErr) {
            console.error('[Voice Inbound] Conversation error (non-fatal):', convErr)
          }
        }
      }
    } catch (dbError) {
      console.error('[Voice Inbound] DB error (non-fatal, proceeding to Retell):', dbError)
    }
  }

  // ── 2. Register the call with Retell (CRITICAL — must succeed) ──
  try {
    const retellRes = await fetch('https://api.retellai.com/v2/register-phone-call', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RETELL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: RETELL_AGENT_ID,
        from_number: from,
        to_number: to,
        direction: 'inbound',
        retell_llm_dynamic_variables: dynamicVariables,
        metadata: {
          twilio_call_sid: callSid,
          lead_id: leadId,
          organization_id: orgId,
          conversation_id: conversationId,
        },
      }),
    })

    if (!retellRes.ok) {
      const errText = await retellRes.text()
      console.error('[Voice Inbound] Retell register failed:', retellRes.status, errText)
      return new NextResponse(
        `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>We're sorry, our AI assistant is temporarily unavailable. Please try again later or leave a message after the beep.</Say>
  <Record maxLength="120" transcribe="true" />
</Response>`,
        { headers: { 'Content-Type': 'text/xml' } }
      )
    }

    const retellData = await retellRes.json()
    const callId = retellData.call_id
    console.log(`[Voice Inbound] Retell call registered: ${callId}`)

    // ── 3. Log call to DB (fire-and-forget) ──
    if (supabase && orgId && leadId) {
      supabase.from('voice_calls').insert({
        organization_id: orgId,
        lead_id: leadId,
        conversation_id: conversationId,
        direction: 'inbound',
        status: 'ringing',
        retell_call_id: callId,
        from_number: from,
        to_number: to,
        started_at: new Date().toISOString(),
        consent_verified: true,
        metadata: {
          twilio_call_sid: callSid,
          caller_city: callerCity,
          caller_state: callerState,
          caller_country: callerCountry,
        },
      }).then(({ error }: { error: unknown }) => {
        if (error) console.error('[Voice Inbound] Failed to log call:', error)
      })
    }

    // ── 4. Return TwiML to bridge to Retell (CRITICAL) ──
    return new NextResponse(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Sip>sip:${callId}@sip.retellai.com;transport=tcp</Sip>
  </Dial>
</Response>`,
      { headers: { 'Content-Type': 'text/xml' } }
    )
  } catch (error) {
    console.error('[Voice Inbound] Fatal error:', error)
    return new NextResponse(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>We're sorry, an error occurred. Please try again later.</Say>
</Response>`,
      { headers: { 'Content-Type': 'text/xml' } }
    )
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
