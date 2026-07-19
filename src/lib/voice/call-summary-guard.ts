import type { VoiceCall } from '@/types/database'

/** The fields the guard needs — a partial row is enough. */
type SummaryGuardInput = Pick<VoiceCall, 'transcript' | 'call_mode'>

/**
 * Whether a call carries a transcript of its own, and therefore a
 * `transcript_summary` that must not be overwritten.
 *
 * The disposition route composes a synthetic summary ("Outbound call · 2:30.
 * Interested. <notes>") from the call's facts. That is the right content for a
 * staff browser call, which never has an AI transcript — the composed line IS
 * the record. It is the wrong content for an AI agent call, whose
 * `transcript_summary` is a real generated summary of what was actually said.
 *
 * Staff can now amend the notes on ANY call after the fact, including AI calls
 * they listened back to. Without this guard, that amendment would replace the
 * AI summary with a one-liner and the original would be unrecoverable — the
 * timeline renders `outcome_notes ?? transcript_summary`, so the loss would not
 * even be visible at the point it happened.
 */
export function hasOwnTranscript(call: SummaryGuardInput): boolean {
  // An AI-placed call owns its summary even before the transcript lands: the
  // transcription is asynchronous, so an amendment made in that window must not
  // clobber the summary that is about to arrive.
  if (call.call_mode === 'ai') return true

  // `transcript` is typed as an entry array, but Retell-sourced rows store a
  // plain "Agent:/User:" string — call-card.tsx tolerates both for the same
  // reason. Widen before narrowing so the string case stays reachable.
  const t = call.transcript as unknown
  if (Array.isArray(t)) return t.length > 0
  if (typeof t === 'string') return t.trim().length > 0
  return Boolean(t)
}
