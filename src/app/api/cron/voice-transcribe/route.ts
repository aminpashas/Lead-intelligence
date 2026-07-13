/**
 * Voice transcription cron — gives staff (browser/bridge) calls the transcript
 * that AI (Retell) calls already get.
 *
 * Retell transcribes its own AI calls and hands us the text in /api/voice/events.
 * Staff softphone / conference-bridge calls only produce a Twilio RECORDING — no
 * text — so their Call Center rows read "No transcript captured". This sweep
 * feeds those recordings through Twilio Voice Intelligence (same Twilio creds, no
 * new vendor) and writes the transcript (+ a Haiku one-line summary) back onto
 * the row, so the transcript renders wherever the AI-call transcript already does.
 *
 * Design:
 *  • Record-only, like voice-reconcile — it does NOT run the encounter processor
 *    or send post-call SMS/email (that path belongs to the live Retell webhook),
 *    so re-running is always safe and idempotent.
 *  • Consent is transitive: a Twilio recording only exists when the call had
 *    recording_disclosure_given, so transcribing an existing recording needs no
 *    extra gate.
 *  • Voice Intelligence is async. To keep each run bounded we use a short poll
 *    budget: the first sweep creates the transcript and stores its SID; a later
 *    sweep resumes via that SID and persists once Twilio finishes.
 *  • Inert until TWILIO_INTELLIGENCE_SERVICE_SID is set (isTranscriptionConfigured),
 *    so it costs nothing until Voice Intelligence is provisioned.
 *
 * Runs every 15 min (see vercel.json).
 */

import { withCron } from '@/lib/cron/with-cron'
import {
  transcribeTwilioRecording,
  isTranscriptionConfigured,
} from '@/lib/voice/transcribe'
import { summarizeCallTranscript } from '@/lib/voice/call-summary'
import {
  selectTranscribeCandidates,
  readTranscribeMeta,
  MAX_TRANSCRIBE_ATTEMPTS,
  type TranscribeCandidateRow,
} from '@/lib/voice/transcribe-batch'
import type { TranscriptLine } from '@/lib/voice/transcript'

export const runtime = 'nodejs'

// Only look this far back — a recording that never transcribed in 2 days won't
// start now, and an unbounded scan would grow forever.
const WINDOW_HOURS = 48
// Give the recording status callback time to land the recording_url before we
// consider a just-ended call.
const GRACE_MINUTES = 2
// How many rows to actually transcribe per run. Each does one create + a short
// poll, so this bounds wall-clock well under the function timeout.
const BATCH_SIZE = 12
// Short per-row poll budget: create + a quick check, then hand back 'processing'
// for a later sweep to resume. Keeps the whole run bounded.
const POLL_BUDGET_MS = 6_000

export const POST = withCron('voice-transcribe', async ({ supabase }) => {
  if (!isTranscriptionConfigured()) {
    return { status: 'skipped', data: { reason: 'transcription_unconfigured' } }
  }

  const now = Date.now()
  const windowStart = new Date(now - WINDOW_HOURS * 60 * 60 * 1000).toISOString()
  const graceCutoff = new Date(now - GRACE_MINUTES * 60 * 1000).toISOString()

  // Pull a recent window of completed Twilio-recorded calls, newest first, then
  // let the pure selector decide which still need (and are eligible for) a
  // transcript. We over-fetch and narrow in JS because "transcript is empty" on
  // a jsonb column doesn't express cleanly as a PostgREST filter.
  const { data: rows, error } = await supabase
    .from('voice_calls')
    .select('id, organization_id, recording_url, transcript, transcript_summary, metadata, ended_at')
    .eq('status', 'completed')
    .not('recording_url', 'is', null)
    .like('recording_url', 'https://api.twilio.com/%')
    .gte('ended_at', windowStart)
    .lte('ended_at', graceCutoff)
    .order('ended_at', { ascending: false })
    .limit(80)

  if (error) throw new Error(`candidate query failed: ${error.message}`)

  const candidates = selectTranscribeCandidates(
    (rows ?? []) as TranscribeCandidateRow[],
    BATCH_SIZE
  )
  if (candidates.length === 0) {
    return { status: 'ok', items: 0, data: { checked: rows?.length ?? 0, transcribed: 0, processing: 0, failed: 0 } }
  }

  let transcribed = 0
  let processing = 0
  let failed = 0

  for (const row of candidates) {
    const meta = readTranscribeMeta(row.metadata)
    const baseMeta = (row.metadata ?? {}) as Record<string, unknown>
    const attempts = (meta.transcribe_attempts ?? 0) + 1

    try {
      const result = await transcribeTwilioRecording({
        recordingUrl: row.recording_url as string,
        existingTranscriptSid: meta.intelligence_transcript_sid,
        maxPollMs: POLL_BUDGET_MS,
      })

      if (result.status === 'unconfigured') {
        // Guarded above, but bail defensively rather than spin the batch.
        break
      }

      if (result.status === 'processing') {
        await supabase
          .from('voice_calls')
          .update({
            metadata: {
              ...baseMeta,
              intelligence_transcript_sid: result.transcriptSid,
              transcribe_status: 'processing',
              transcribe_attempts: attempts,
            },
          })
          .eq('id', row.id)
        processing++
        continue
      }

      if (result.status === 'failed') {
        const exhausted = attempts >= MAX_TRANSCRIBE_ATTEMPTS
        await supabase
          .from('voice_calls')
          .update({
            metadata: {
              ...baseMeta,
              transcribe_status: exhausted ? 'failed' : undefined,
              transcribe_attempts: attempts,
              transcribe_error: result.error,
            },
          })
          .eq('id', row.id)
        failed++
        continue
      }

      // status === 'completed'
      const lines: TranscriptLine[] = result.lines
      const update: Record<string, unknown> = {
        transcript: lines,
        metadata: {
          ...baseMeta,
          intelligence_transcript_sid: result.transcriptSid,
          transcribe_status: 'done',
          transcribe_attempts: attempts,
          transcribe_error: null,
        },
      }

      // Fill the TL;DR the call card shows above the transcript, if it's empty.
      // Best-effort and cheap (Haiku); a miss just leaves the summary blank.
      if (!row.transcript_summary && lines.length > 0) {
        const text = lines.map((l) => `${l.role === 'agent' ? 'Staff' : 'Patient'}: ${l.content}`).join('\n')
        const summary = await summarizeCallTranscript(text)
        if (summary.status === 'ok') update.transcript_summary = summary.summary.headline
      }

      await supabase.from('voice_calls').update(update).eq('id', row.id)
      transcribed++
    } catch (err) {
      console.error('[voice-transcribe] row error', row.id, err)
      failed++
    }
  }

  return {
    status: 'ok',
    items: transcribed,
    data: { checked: rows?.length ?? 0, candidates: candidates.length, transcribed, processing, failed },
  }
})

// Vercel Cron invokes cron routes with a GET request; alias it to the POST
// handler so this scheduled route actually runs (matches every other cron route).
export const GET = POST
