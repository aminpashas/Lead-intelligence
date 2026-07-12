/**
 * Speech-to-text for Twilio call recordings via Twilio Voice Intelligence.
 *
 * Fills the STT seam noted in call-summary.ts for HUMAN (browser-softphone)
 * calls: AI calls get transcripts from Retell, but staff calls only have a
 * conference recording. Voice Intelligence transcribes a recording by SID —
 * no new vendor, same Twilio credentials.
 *
 * Setup: create a Voice Intelligence Service in the Twilio console and set
 * TWILIO_INTELLIGENCE_SERVICE_SID. Without it, callers get 'unconfigured'
 * and should fall back to whatever text the call already carries.
 *
 * Transcription is async on Twilio's side (roughly real-time-factor ~0.2),
 * so callers pass back `transcriptSid` to resume polling on a later request
 * instead of holding the connection open indefinitely.
 */

import type { TranscriptLine } from '@/lib/voice/transcript'

const INTELLIGENCE_BASE = 'https://intelligence.twilio.com/v2'
/** How long a single request is willing to wait before handing back 'processing'. */
const MAX_POLL_MS = 60_000
const POLL_INTERVAL_MS = 4_000

export type TranscribeResult =
  | { status: 'completed'; lines: TranscriptLine[]; transcriptSid: string }
  | { status: 'processing'; transcriptSid: string }
  | { status: 'failed'; error: string }
  | { status: 'unconfigured' }

export function isTranscriptionConfigured(): boolean {
  return !!(
    process.env.TWILIO_INTELLIGENCE_SERVICE_SID &&
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN
  )
}

function authHeader(): string {
  return `Basic ${Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString('base64')}`
}

/** Pull the RE… recording SID out of a Twilio recording URL. */
export function recordingSidFromUrl(recordingUrl: string): string | null {
  const m = recordingUrl.match(/\/Recordings\/(RE[0-9a-f]{32})/i)
  return m ? m[1] : null
}

/**
 * Transcribe a Twilio recording. Pass `existingTranscriptSid` (from a prior
 * 'processing' result) to resume instead of creating a duplicate transcript.
 */
export async function transcribeTwilioRecording(input: {
  recordingUrl: string
  existingTranscriptSid?: string | null
}): Promise<TranscribeResult> {
  if (!isTranscriptionConfigured()) return { status: 'unconfigured' }

  let transcriptSid = input.existingTranscriptSid || null

  if (!transcriptSid) {
    const sourceSid = recordingSidFromUrl(input.recordingUrl)
    if (!sourceSid) return { status: 'failed', error: 'Could not extract recording SID from URL' }

    const res = await fetch(`${INTELLIGENCE_BASE}/Transcripts`, {
      method: 'POST',
      headers: { Authorization: authHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ServiceSid: process.env.TWILIO_INTELLIGENCE_SERVICE_SID!,
        Channel: JSON.stringify({ media_properties: { source_sid: sourceSid } }),
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      return { status: 'failed', error: `Transcript create failed (${res.status}): ${body.slice(0, 300)}` }
    }
    transcriptSid = ((await res.json()) as { sid: string }).sid
  }

  // Poll until completed or our per-request budget runs out.
  const deadline = Date.now() + MAX_POLL_MS
  for (;;) {
    const res = await fetch(`${INTELLIGENCE_BASE}/Transcripts/${transcriptSid}`, {
      headers: { Authorization: authHeader() },
    })
    if (!res.ok) return { status: 'failed', error: `Transcript fetch failed (${res.status})` }
    const data = (await res.json()) as { status: string }

    if (data.status === 'completed') break
    if (data.status === 'failed' || data.status === 'canceled') {
      return { status: 'failed', error: `Transcription ${data.status}` }
    }
    if (Date.now() >= deadline) return { status: 'processing', transcriptSid }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }

  const sentencesRes = await fetch(
    `${INTELLIGENCE_BASE}/Transcripts/${transcriptSid}/Sentences?PageSize=1000`,
    { headers: { Authorization: authHeader() } }
  )
  if (!sentencesRes.ok) return { status: 'failed', error: `Sentences fetch failed (${sentencesRes.status})` }
  const payload = (await sentencesRes.json()) as {
    sentences?: Array<{ transcript?: string; media_channel?: number }>
  }

  // Conference recordings are mixed-mono, so channel rarely separates speakers;
  // role tags are best-effort (channel 1 → staff side). The text is what the
  // training extractor consumes, so imperfect diarization is acceptable.
  const lines: TranscriptLine[] = (payload.sentences || [])
    .map((s) => ({
      role: (s.media_channel === 2 ? 'lead' : 'agent') as TranscriptLine['role'],
      content: String(s.transcript ?? '').trim(),
    }))
    .filter((l) => l.content.length > 0)

  return { status: 'completed', lines, transcriptSid }
}
