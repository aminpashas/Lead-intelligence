/**
 * Twilio Voice (browser softphone) — server-side helpers.
 *
 * The browser holds a Twilio `Device` authorized by a short-lived AccessToken we
 * mint here. When the device places a call, Twilio fetches TwiML from
 * /api/voice/twiml/outbound; `buildAgentConferenceTwiml` + `dialLeadIntoConference`
 * bridge the staff member and lead through a Conference so the lead can be put on
 * hold with music mid-call (see the conference section below).
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

// ─────────────────────────────────────────────────────────────────────────────
// Conference bridge (enables mid-call hold with music)
//
// A peer <Dial> can't be put on hold — pulling either leg aside to play music
// tears the bridge down. So the browser call bridges both parties through a
// Conference named `room_<callId>`: the agent joins from their browser leg, and
// we originate the lead's leg into the same room. Holding = updating the lead's
// conference participant with hold=true, which isolates them from the room and
// plays Twilio's hold music to them (both directions go quiet automatically).
// ─────────────────────────────────────────────────────────────────────────────

/** The conference friendly name for a given voice_calls row. */
export function conferenceNameForCall(callId: string): string {
  return `room_${callId}`
}

/**
 * A REST client for conference control (originate the lead leg, hold/resume the
 * participant). Uses the account auth token — the API-key credentials only grant
 * the browser AccessToken, not REST conference operations.
 */
function restClient() {
  return twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!)
}

/**
 * Agent (browser) leg TwiML: join the conference. The agent starts the conference
 * and ending their leg ends the whole call. Recording (opt-in) is attached here,
 * on the conference, so the whole bridge is captured once.
 */
export function buildAgentConferenceTwiml(params: {
  callId: string
  recordingStatusCallbackUrl: string
  record: boolean
}): string {
  const { callId, recordingStatusCallbackUrl, record } = params
  const response = new twilio.twiml.VoiceResponse()
  const dial = response.dial({ answerOnBridge: true })
  dial.conference(
    {
      startConferenceOnEnter: true,
      endConferenceOnExit: true, // agent hangs up → conference (and lead leg) ends
      beep: 'false' as const,
      // No conference statusCallback: conference events carry no CallStatus and
      // would confuse the leg-status tracker. The lead leg's own call
      // statusCallback drives ringing → answered → completed instead.
      ...(record
        ? {
            record: 'record-from-start' as const,
            recordingStatusCallback: recordingStatusCallbackUrl,
            recordingStatusCallbackMethod: 'POST' as const,
          }
        : {}),
    },
    conferenceNameForCall(callId)
  )
  return response.toString()
}

/**
 * Originate the lead's leg into the conference. Its call statusCallback (carrying
 * `?voiceCallId=`) feeds /api/voice/status exactly like the old child leg did.
 * `waitUrl`/hold music is left to Twilio's default so there's no external asset to
 * depend on. Returns the lead leg's Call SID (stored so we can hold it).
 */
export async function dialLeadIntoConference(params: {
  callId: string
  toNumber: string
  callerId: string
  statusCallbackUrl: string
}): Promise<string> {
  const { callId, toNumber, callerId, statusCallbackUrl } = params

  const twiml = new twilio.twiml.VoiceResponse()
  const dial = twiml.dial({ answerOnBridge: true })
  dial.conference(
    {
      startConferenceOnEnter: true,
      endConferenceOnExit: true, // lead hangs up → conference ends (agent dropped)
      beep: 'false' as const,
    },
    conferenceNameForCall(callId)
  )

  const call = await restClient().calls.create({
    to: toNumber,
    from: callerId,
    twiml: twiml.toString(),
    statusCallback: statusCallbackUrl,
    statusCallbackMethod: 'POST',
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
  })
  return call.sid
}

/**
 * Hold or resume the lead participant in the call's conference. Addresses the
 * participant by its stored Call SID within the in-progress conference. Omitting
 * `holdUrl` makes Twilio play its default hold music to the held lead.
 *
 * Returns false when there's no live conference/participant to act on (e.g. the
 * lead already hung up) so the caller can report it without treating it as a crash.
 */
export async function setLeadHold(params: {
  callId: string
  leadCallSid: string
  hold: boolean
}): Promise<boolean> {
  const { callId, leadCallSid, hold } = params
  const client = restClient()

  const conferences = await client.conferences.list({
    friendlyName: conferenceNameForCall(callId),
    status: 'in-progress',
    limit: 1,
  })
  const conference = conferences[0]
  if (!conference) return false

  try {
    await client.conferences(conference.sid).participants(leadCallSid).update({
      hold,
      holdMethod: 'POST',
    })
    return true
  } catch {
    // Participant gone (lead dropped) or transiently unavailable.
    return false
  }
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
