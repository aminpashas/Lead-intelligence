import { NextRequest, NextResponse } from 'next/server'

/**
 * Twilio Voice Webhook — Inbound Call Handler
 *
 * When someone calls your Twilio number:
 * 1. Twilio hits this webhook
 * 2. We register the call with Retell to get a SIP URI
 * 3. We return TwiML that dials the Retell SIP address
 * 4. Retell's AI agent handles the conversation
 */

const RETELL_API_KEY = process.env.RETELL_API_KEY || ''
const RETELL_AGENT_ID = 'agent_d5891af66aa9f7a83b9f96fc3a'

export async function POST(req: NextRequest) {
  try {
    // Parse Twilio's form-encoded webhook body
    const formData = await req.formData()
    const from = formData.get('From') as string || ''
    const to = formData.get('To') as string || ''
    const callSid = formData.get('CallSid') as string || ''

    console.log(`[Voice Inbound] Call from ${from} to ${to}, SID: ${callSid}`)

    // Register the call with Retell to get a SIP endpoint
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
        metadata: {
          twilio_call_sid: callSid,
        },
      }),
    })

    if (!retellRes.ok) {
      const errText = await retellRes.text()
      console.error('[Voice Inbound] Retell register failed:', errText)
      // Fallback: play a message if Retell is unreachable
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

    // Return TwiML that dials Retell's SIP endpoint
    // The call audio will flow: Caller <-> Twilio <-> Retell SIP <-> AI Agent
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
