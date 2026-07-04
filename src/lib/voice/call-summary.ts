/**
 * Call summarizer — turns a call TRANSCRIPT into a structured, caller-ready
 * summary so a rep/AI reads context before dialing back.
 *
 * Scope of this module: transcript → summary (via Claude Haiku, mirroring
 * src/lib/ai/summarize.ts). It deliberately does NOT do speech-to-text.
 *
 * WHERE THE TRANSCRIPT COMES FROM:
 *   • GHL-provided transcript/body on the call message (if the location has it —
 *     confirm with scripts/ghl-probe-call-payload.ts), OR
 *   • an STT pass over the recording URL — NOT wired: the repo has no STT
 *     provider (only @anthropic-ai/sdk, and Claude cannot transcribe audio).
 *     `transcribeRecording` below is an explicit seam; provision Whisper /
 *     Deepgram / AssemblyAI (API key) and implement it to unlock summaries for
 *     recording-only calls. Until then, only calls that already carry text can
 *     be summarized.
 *
 * Best-effort: never throws — a summary hiccup must not fail a backfill/cron.
 */

import Anthropic from '@anthropic-ai/sdk'

const CALL_SUMMARY_MODEL = 'claude-haiku-4-5'
const MAX_OUTPUT_TOKENS = 400
/** Below this, there isn't enough spoken content to summarize meaningfully. */
export const MIN_TRANSCRIPT_CHARS = 120

const CALL_SUMMARY_PROMPT = `You are summarizing a past phone call between a dental implant practice and a prospective or existing patient, for the rep who is about to call them back. Output STRICT JSON only — no prose, no markdown fences.

Schema:
{
  "headline": "one sentence a rep can read in 2 seconds",
  "topics": ["what was discussed"],
  "objections": ["concerns/hesitations raised, if any"],
  "commitments": ["anything either side promised to do"],
  "next_step": "the single most useful next action",
  "sentiment": "positive" | "neutral" | "negative"
}

Be factual — never invent details not in the transcript. Use exact names/numbers where present. Empty arrays are fine.`

export type CallSummary = {
  headline: string
  topics: string[]
  objections: string[]
  commitments: string[]
  next_step: string
  sentiment: 'positive' | 'neutral' | 'negative'
}

export type SummarizeCallResult =
  | { status: 'ok'; summary: CallSummary; tokensIn: number; tokensOut: number }
  | { status: 'skipped_too_short' }
  | { status: 'failed'; error: string }

function getAnthropic() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
}

/** Pull the first balanced JSON object out of a model reply (defensive vs. stray prose). */
export function parseCallSummary(raw: string): CallSummary | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as Partial<CallSummary>
    if (typeof obj.headline !== 'string') return null
    return {
      headline: obj.headline,
      topics: Array.isArray(obj.topics) ? obj.topics.map(String) : [],
      objections: Array.isArray(obj.objections) ? obj.objections.map(String) : [],
      commitments: Array.isArray(obj.commitments) ? obj.commitments.map(String) : [],
      next_step: typeof obj.next_step === 'string' ? obj.next_step : '',
      sentiment:
        obj.sentiment === 'positive' || obj.sentiment === 'negative' ? obj.sentiment : 'neutral',
    }
  } catch {
    return null
  }
}

/**
 * Summarize a call transcript. Pure aside from the single Claude call; returns a
 * typed result and never throws.
 */
export async function summarizeCallTranscript(transcript: string): Promise<SummarizeCallResult> {
  const text = (transcript || '').trim()
  if (text.length < MIN_TRANSCRIPT_CHARS) return { status: 'skipped_too_short' }
  try {
    const response = await getAnthropic().messages.create({
      model: CALL_SUMMARY_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: CALL_SUMMARY_PROMPT,
      messages: [{ role: 'user', content: `Call transcript:\n\n${text}` }],
    })
    const raw = response.content
      .filter((c) => c.type === 'text')
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('\n')
    const summary = parseCallSummary(raw)
    if (!summary) return { status: 'failed', error: 'unparseable_response' }
    return {
      status: 'ok',
      summary,
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
    }
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : 'unknown' }
  }
}

/**
 * SEAM — speech-to-text for a recording URL. Intentionally unimplemented: no STT
 * provider is provisioned in this repo. Provision one (Whisper/Deepgram/
 * AssemblyAI), add its key to env, and implement here to unlock summaries for
 * calls that have only a recording (no GHL-provided transcript).
 */
export async function transcribeRecording(_recordingUrl: string): Promise<never> {
  throw new Error(
    'transcribeRecording: no STT provider configured — provision Whisper/Deepgram/AssemblyAI and implement this seam',
  )
}
