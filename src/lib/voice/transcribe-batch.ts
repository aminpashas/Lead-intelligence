/**
 * Candidate selection for the voice-transcribe cron.
 *
 * Split out from the route so the "which staff recordings still need a
 * transcript" decision is a pure function we can unit-test without Supabase or
 * Twilio. The cron fetches a recent window of completed calls and this narrows
 * it to the rows worth spending a Voice Intelligence transcription on.
 */

import { isTwilioRecordingUrl } from '@/lib/voice/recording-playback'
import { toTranscriptLines } from '@/lib/voice/transcript'

/** Give up after this many failed/incomplete attempts so a permanently
 *  un-transcribable recording can't be retried forever. */
export const MAX_TRANSCRIBE_ATTEMPTS = 5

/** The subset of a voice_calls row this selector reads. */
export type TranscribeCandidateRow = {
  id: string
  organization_id: string | null
  recording_url: string | null
  transcript?: unknown
  transcript_summary?: string | null
  metadata?: Record<string, unknown> | null
}

/** Per-row transcription bookkeeping we stash in voice_calls.metadata. */
export type TranscribeMeta = {
  intelligence_transcript_sid?: string | null
  transcribe_status?: 'processing' | 'done' | 'failed'
  transcribe_attempts?: number
  transcribe_error?: string | null
}

export function readTranscribeMeta(
  metadata: Record<string, unknown> | null | undefined
): TranscribeMeta {
  const m = (metadata ?? {}) as Record<string, unknown>
  return {
    intelligence_transcript_sid:
      typeof m.intelligence_transcript_sid === 'string' ? m.intelligence_transcript_sid : null,
    transcribe_status:
      m.transcribe_status === 'processing' ||
      m.transcribe_status === 'done' ||
      m.transcribe_status === 'failed'
        ? m.transcribe_status
        : undefined,
    transcribe_attempts:
      typeof m.transcribe_attempts === 'number' ? m.transcribe_attempts : 0,
    transcribe_error: typeof m.transcribe_error === 'string' ? m.transcribe_error : null,
  }
}

/**
 * True when a row is a staff Twilio recording that still needs (and is still
 * eligible for) a transcript:
 *   • has a Twilio recording URL (Retell calls carry their own transcript and a
 *     non-Twilio recording URL, so they're excluded),
 *   • has no usable transcript yet,
 *   • hasn't been marked done, and
 *   • hasn't exhausted its retry budget.
 */
export function needsTranscription(row: TranscribeCandidateRow): boolean {
  if (!row.recording_url || !isTwilioRecordingUrl(row.recording_url)) return false
  if (toTranscriptLines({ transcript: row.transcript }).length > 0) return false
  const meta = readTranscribeMeta(row.metadata)
  if (meta.transcribe_status === 'done') return false
  if ((meta.transcribe_attempts ?? 0) >= MAX_TRANSCRIBE_ATTEMPTS) return false
  return true
}

/**
 * Narrow a fetched window down to the batch the cron will actually process this
 * run. Rows already mid-flight ('processing', i.e. we hold a transcript SID to
 * resume) are prioritized over brand-new ones so in-progress transcriptions
 * finish before we pay to start more.
 */
export function selectTranscribeCandidates(
  rows: TranscribeCandidateRow[],
  batchSize: number
): TranscribeCandidateRow[] {
  const eligible = rows.filter(needsTranscription)
  const resuming = eligible.filter(
    (r) => readTranscribeMeta(r.metadata).transcribe_status === 'processing'
  )
  const fresh = eligible.filter(
    (r) => readTranscribeMeta(r.metadata).transcribe_status !== 'processing'
  )
  return [...resuming, ...fresh].slice(0, Math.max(0, batchSize))
}
