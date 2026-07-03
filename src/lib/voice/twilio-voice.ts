/**
 * Twilio Voice (browser softphone) — server-side helpers.
 *
 * The browser holds a Twilio `Device` authorized by a short-lived AccessToken we
 * mint here. When the device places a call, Twilio fetches TwiML from
 * /api/voice/twiml/outbound; `buildOutboundDialTwiml` produces the <Dial> that
 * bridges the staff member to the lead.
 *
 * This module is server-only (imports the Node twilio SDK + reads secrets).
 */

import twilio from 'twilio'

const AccessToken = twilio.jwt.AccessToken
const VoiceGrant = AccessToken.VoiceGrant

/** Token lifetime. Long enough for a shift's worth of calls; the browser refreshes on expiry. */
const TOKEN_TTL_SECONDS = 60 * 60 // 1 hour

/** True only when all three softphone secrets are present. */
export function isSoftphoneConfigured(): boolean {
  return !!(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_API_KEY &&
    process.env.TWILIO_API_SECRET &&
    process.env.TWILIO_TWIML_APP_SID
  )
}

/** Stable Twilio client identity for a staff user. Also the token's `identity`. */
export function identityForUser(userId: string): string {
  return `staff_${userId}`
}

/**
 * Mint a browser Voice access token for a staff member. Grants OUTGOING calls via
 * our TwiML App only; incoming is disabled (staff don't receive calls on the
 * softphone in Phase 1).
 */
export function mintVoiceToken(userId: string): { token: string; identity: string; expiresInSeconds: number } {
  if (!isSoftphoneConfigured()) {
    throw new Error('Softphone not configured (missing TWILIO_API_KEY/SECRET/TWIML_APP_SID)')
  }

  const identity = identityForUser(userId)
  const token = new AccessToken(
    process.env.TWILIO_ACCOUNT_SID!,
    process.env.TWILIO_API_KEY!,
    process.env.TWILIO_API_SECRET!,
    { identity, ttl: TOKEN_TTL_SECONDS }
  )

  token.addGrant(
    new VoiceGrant({
      outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID!,
      incomingAllow: false,
    })
  )

  return { token: token.toJwt(), identity, expiresInSeconds: TOKEN_TTL_SECONDS }
}

/**
 * Build the <Dial> TwiML that bridges the staff browser leg to the lead.
 *
 * - `callerId` is the org's outbound number (what the lead sees).
 * - Per-leg + parent status callbacks feed /api/voice/status so we can track
 *   ringing → answered → completed and store duration/recording.
 * - Recording is enabled only when the org opts in.
 */
export function buildOutboundDialTwiml(params: {
  toNumber: string
  callerId: string
  statusCallbackUrl: string
  recordingStatusCallbackUrl: string
  record: boolean
}): string {
  const { toNumber, callerId, statusCallbackUrl, recordingStatusCallbackUrl, record } = params

  const response = new twilio.twiml.VoiceResponse()
  const dial = response.dial({
    callerId,
    answerOnBridge: true, // lead doesn't hear ringback until they actually connect
    ...(record
      ? {
          record: 'record-from-answer-dual' as const,
          recordingStatusCallback: recordingStatusCallbackUrl,
          recordingStatusCallbackMethod: 'POST' as const,
        }
      : {}),
  })

  dial.number(
    {
      statusCallback: statusCallbackUrl,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    },
    toNumber
  )

  return response.toString()
}

/** Map a Twilio CallStatus to our voice_calls.status vocabulary. */
export function mapTwilioStatus(twilioStatus: string): string {
  switch (twilioStatus) {
    case 'queued':
    case 'initiated':
      return 'initiated'
    case 'ringing':
      return 'ringing'
    case 'in-progress':
      return 'in_progress'
    case 'completed':
      return 'completed'
    case 'busy':
      return 'busy'
    case 'no-answer':
      return 'no_answer'
    case 'canceled':
      return 'canceled'
    case 'failed':
      return 'failed'
    default:
      return 'in_progress'
  }
}
