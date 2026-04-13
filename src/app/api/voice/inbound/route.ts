import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'

/**
 * Twilio Voice Webhook — Inbound Call Handler
 *
 * When someone calls your Twilio number:
 * 1. Twilio hits this webhook with caller info
 * 2. We look up the caller's phone number in our leads database
 * 3. If no lead exists, we auto-create one from the phone number
 * 4. We register the call with Retell, passing lead context to the AI
 * 5. We return TwiML that dials the Retell SIP address
 * 6. Retell's AI agent handles the conversation with full caller context
 */

const RETELL_API_KEY = process.env.RETELL_API_KEY || ''
const RETELL_AGENT_ID = 'agent_d5891af66aa9f7a83b9f96fc3a'

export async function POST(req: NextRequest) {
  try {
    const supabase = createServiceClient()

    // Parse Twilio's form-encoded webhook body
    const formData = await req.formData()
    const from = formData.get('From') as string || ''
    const to = formData.get('To') as string || ''
    const callSid = formData.get('CallSid') as string || ''
    const callerCity = formData.get('CallerCity') as string || ''
    const callerState = formData.get('CallerState') as string || ''
    const callerCountry = formData.get('CallerCountry') as string || ''
    const callerName = formData.get('CallerName') as string || '' // CNAM lookup

    console.log(`[Voice Inbound] Call from ${from} to ${to}, SID: ${callSid}`)
    console.log(`[Voice Inbound] Caller info: city=${callerCity}, state=${callerState}, name=${callerName}`)

    // ── 1. Get the organization linked to this phone number ──
    const { data: org } = await supabase
      .from('organizations')
      .select('id, name, voice_greeting')
      .eq('voice_outbound_caller_id', to)
      .single()

    const orgId = org?.id
    const practiceName = org?.name || 'our practice'

    // ── 2. Look up the caller in our leads database ──
    // Normalize the phone number (strip +1 prefix for matching)
    const normalizedPhone = from.replace(/^\+1/, '').replace(/\D/g, '')
    const phoneVariants = [
      from,                           // +14155551234
      normalizedPhone,                // 4155551234
      `+1${normalizedPhone}`,         // +14155551234
      `(${normalizedPhone.slice(0,3)}) ${normalizedPhone.slice(3,6)}-${normalizedPhone.slice(6)}`, // (415) 555-1234
    ]

    let lead: Record<string, unknown> | null = null
    let isNewLead = false

    if (orgId) {
      // Search for existing lead by phone
      const { data: existingLead } = await supabase
        .from('leads')
        .select('id, first_name, last_name, email, phone, status, lead_score, notes, source, personality_profile')
        .eq('organization_id', orgId)
        .or(phoneVariants.map(p => `phone.eq.${p}`).join(','))
        .limit(1)
        .single()

      if (existingLead) {
        lead = existingLead
        console.log(`[Voice Inbound] Found existing lead: ${lead.first_name} ${lead.last_name} (${lead.id})`)
      } else {
        // Auto-create a new lead from the inbound call
        const displayName = callerName || `Caller ${normalizedPhone.slice(-4)}`
        const nameParts = displayName.split(' ')
        
        const { data: newLead, error: createErr } = await supabase
          .from('leads')
          .insert({
            organization_id: orgId,
            first_name: nameParts[0] || 'Unknown',
            last_name: nameParts.slice(1).join(' ') || 'Caller',
            phone: from,
            source: 'inbound_call',
            status: 'new',
            lead_score: 50,  // Inbound callers get a decent starting score — they called us!
            notes: `Auto-created from inbound call on ${new Date().toLocaleDateString()}. ${callerCity ? `Location: ${callerCity}, ${callerState}` : ''}`.trim(),
            voice_consent: true,
            voice_consent_at: new Date().toISOString(),
            voice_consent_source: 'inbound_call',
          })
          .select()
          .single()

        if (!createErr && newLead) {
          lead = newLead
          isNewLead = true
          console.log(`[Voice Inbound] Created new lead: ${newLead.id} (${displayName})`)
        } else {
          console.error('[Voice Inbound] Failed to create lead:', createErr)
        }
      }
    }

    // ── 3. Build dynamic variables for the AI agent ──
    const firstName = (lead?.first_name as string) || ''
    const lastName = (lead?.last_name as string) || ''
    const leadStatus = (lead?.status as string) || 'unknown'
    const leadScore = (lead?.lead_score as number) || 0
    const leadNotes = (lead?.notes as string) || ''
    const leadSource = (lead?.source as string) || 'unknown'

    // Extract personality insights if available
    const personality = lead?.personality_profile as Record<string, unknown> | null
    const personalityType = personality?.type as string || ''
    const communicationStyle = personality?.communication_style as string || ''

    const dynamicVariables: Record<string, string> = {
      caller_phone: from,
      caller_first_name: firstName,
      caller_last_name: lastName,
      caller_full_name: `${firstName} ${lastName}`.trim() || 'the caller',
      caller_location: [callerCity, callerState].filter(Boolean).join(', ') || 'unknown',
      lead_status: leadStatus,
      lead_score: String(leadScore),
      lead_source: leadSource,
      lead_notes: leadNotes.slice(0, 500), // Truncate to avoid token waste
      is_new_lead: String(isNewLead),
      is_returning: String(!isNewLead && !!lead),
      practice_name: practiceName,
      personality_type: personalityType,
      communication_style: communicationStyle,
    }

    console.log(`[Voice Inbound] Dynamic vars:`, JSON.stringify({
      caller: dynamicVariables.caller_full_name,
      status: leadStatus,
      isNew: isNewLead,
      score: leadScore,
    }))

    // ── 4. Register the call with Retell ──
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
          lead_id: lead?.id || null,
          organization_id: orgId || null,
          is_new_lead: isNewLead,
        },
      }),
    })

    if (!retellRes.ok) {
      const errText = await retellRes.text()
      console.error('[Voice Inbound] Retell register failed:', errText)
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

    // ── 5. Log the call in our voice_calls table ──
    if (orgId && lead?.id) {
      await supabase.from('voice_calls').insert({
        organization_id: orgId,
        lead_id: lead.id,
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
          is_new_lead: isNewLead,
        },
      }).then(({ error }) => {
        if (error) console.error('[Voice Inbound] Failed to log call:', error)
      })
    }

    // ── 6. Return TwiML to bridge to Retell ──
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Sip>sip:${callId}@sip.retellai.com;transport=tcp</Sip>
  </Dial>
</Response>`

    return new NextResponse(twiml, {
      headers: { 'Content-Type': 'text/xml' },
    })
  } catch (error) {
    console.error('[Voice Inbound] Error:', error)
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
