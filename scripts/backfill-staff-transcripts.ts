/**
 * Backfill transcripts for historical staff (Twilio) call recordings.
 *
 * WHY THIS EXISTS
 * ---------------
 * Retell AI calls carry their own transcript; staff softphone / conference-bridge
 * calls only produce a Twilio RECORDING, so their Call Center rows read
 * "No transcript captured". The /api/cron/voice-transcribe sweep now transcribes
 * these going forward, but it only looks back 48h. This one-shot walks the WHOLE
 * history and transcribes every older staff recording that still lacks text,
 * using the exact same Twilio Voice Intelligence path as the cron.
 *
 * SHARES THE CRON'S LOGIC
 * -----------------------
 * Candidate eligibility (`needsTranscription`) and per-row bookkeeping
 * (`readTranscribeMeta`) are imported from src/lib/voice/transcribe-batch, so this
 * backfill and the live cron can never disagree on what "needs a transcript" means
 * or trample each other's state. Both key resume off
 * metadata.intelligence_transcript_sid and both honor MAX_TRANSCRIBE_ATTEMPTS, so
 * running this while the cron is live is safe.
 *
 * IDEMPOTENT / RESUMABLE
 * ----------------------
 * Skips rows that already have a transcript, are marked done, or exhausted their
 * retry budget. A row Twilio is still transcribing is left 'processing' with its
 * SID stored; re-running resumes it instead of paying to re-create it. Record-only
 * — never runs the encounter processor or sends any follow-up (that path belongs
 * to the live Retell webhook), so re-running can't message a patient.
 *
 * COST
 * ----
 * Each transcription bills Twilio Voice Intelligence per recorded minute. Dry run
 * (the default) reports how many recordings qualify and their total minutes so you
 * can size the spend BEFORE committing. Nothing is transcribed without --apply.
 *
 * Usage:
 *   npx tsx scripts/backfill-staff-transcripts.ts                 # dry run (default): count + minutes
 *   npx tsx scripts/backfill-staff-transcripts.ts --apply         # transcribe all eligible
 *   npx tsx scripts/backfill-staff-transcripts.ts --apply --limit 50   # cap this run
 *   npx tsx scripts/backfill-staff-transcripts.ts --days 90       # only calls ended within 90d
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import {
  transcribeTwilioRecording,
  isTranscriptionConfigured,
} from '../src/lib/voice/transcribe'
import { summarizeCallTranscript } from '../src/lib/voice/call-summary'
import {
  needsTranscription,
  readTranscribeMeta,
  MAX_TRANSCRIBE_ATTEMPTS,
  type TranscribeCandidateRow,
} from '../src/lib/voice/transcribe-batch'

const APPLY = process.argv.includes('--apply')

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null
}
const LIMIT = argValue('--limit') ? Math.max(1, parseInt(argValue('--limit')!, 10)) : Infinity
const DAYS = argValue('--days') ? Math.max(1, parseInt(argValue('--days')!, 10)) : null

// Full poll budget per row — this is a manual one-shot, so unlike the cron we can
// afford to wait for Twilio to finish rather than deferring to a later sweep.
const PAGE = 500

function req(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`Missing env: ${name}`)
    process.exit(1)
  }
  return v
}

const supabase = createClient(req('NEXT_PUBLIC_SUPABASE_URL'), req('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false },
})

type Row = TranscribeCandidateRow & {
  duration_seconds: number | null
  recording_duration_seconds: number | null
  ended_at: string | null
}

/** Page through every completed Twilio-recorded call and keep the ones that
 *  still need a transcript. */
async function collectCandidates(): Promise<Row[]> {
  const sinceIso = DAYS ? new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString() : null
  const out: Row[] = []
  let from = 0

  for (;;) {
    let query = supabase
      .from('voice_calls')
      .select(
        'id, organization_id, recording_url, transcript, transcript_summary, metadata, ended_at, duration_seconds, recording_duration_seconds',
      )
      .eq('status', 'completed')
      .not('recording_url', 'is', null)
      .like('recording_url', 'https://api.twilio.com/%')
      .order('ended_at', { ascending: false })
      .range(from, from + PAGE - 1)
    if (sinceIso) query = query.gte('ended_at', sinceIso)

    const { data, error } = await query
    if (error) throw new Error(`candidate query failed: ${error.message}`)
    const rows = (data ?? []) as Row[]
    out.push(...rows.filter((r) => needsTranscription(r)))
    if (rows.length < PAGE) break
    from += PAGE
  }
  return out
}

/** Recorded minutes for a row, preferring the recording's own duration. */
function minutesOf(r: Row): number {
  const secs = r.recording_duration_seconds ?? r.duration_seconds ?? 0
  return secs / 60
}

async function transcribeOne(row: Row): Promise<'done' | 'processing' | 'failed'> {
  const meta = readTranscribeMeta(row.metadata)
  const baseMeta = (row.metadata ?? {}) as Record<string, unknown>
  const attempts = (meta.transcribe_attempts ?? 0) + 1

  const result = await transcribeTwilioRecording({
    recordingUrl: row.recording_url as string,
    existingTranscriptSid: meta.intelligence_transcript_sid,
  })

  if (result.status === 'unconfigured') throw new Error('transcription became unconfigured mid-run')

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
    return 'processing'
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
    return 'failed'
  }

  // completed
  const lines = result.lines
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
  if (!row.transcript_summary && lines.length > 0) {
    const text = lines.map((l) => `${l.role === 'agent' ? 'Staff' : 'Patient'}: ${l.content}`).join('\n')
    const summary = await summarizeCallTranscript(text)
    if (summary.status === 'ok') update.transcript_summary = summary.summary.headline
  }
  await supabase.from('voice_calls').update(update).eq('id', row.id)
  return 'done'
}

async function main() {
  if (!isTranscriptionConfigured()) {
    console.error(
      'Voice Intelligence is not configured. Set TWILIO_INTELLIGENCE_SERVICE_SID (+ TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN) and retry.',
    )
    process.exit(1)
  }

  console.log(
    `Scanning staff (Twilio) recordings without a transcript${DAYS ? ` (last ${DAYS}d)` : ' (all time)'}…`,
  )
  const candidates = await collectCandidates()
  const totalMinutes = candidates.reduce((m, r) => m + minutesOf(r), 0)

  console.log(`\nEligible recordings: ${candidates.length}`)
  console.log(`Total recorded time:  ${totalMinutes.toFixed(1)} min (billed at Twilio Voice Intelligence per-minute pricing)`)

  if (!APPLY) {
    console.log('\nDry run — nothing transcribed. Re-run with --apply to transcribe.')
    return
  }

  const batch = candidates.slice(0, LIMIT === Infinity ? candidates.length : LIMIT)
  console.log(`\n--apply: transcribing ${batch.length}${batch.length < candidates.length ? ` of ${candidates.length}` : ''}…\n`)

  let done = 0
  let processing = 0
  let failed = 0
  for (let i = 0; i < batch.length; i++) {
    const row = batch[i]
    try {
      const outcome = await transcribeOne(row)
      if (outcome === 'done') done++
      else if (outcome === 'processing') processing++
      else failed++
    } catch (err) {
      failed++
      console.error(`  [${row.id}] error:`, err instanceof Error ? err.message : err)
    }
    if ((i + 1) % 10 === 0 || i === batch.length - 1) {
      console.log(`  progress ${i + 1}/${batch.length} — done:${done} processing:${processing} failed:${failed}`)
    }
  }

  console.log(`\nComplete. transcribed:${done} still-processing:${processing} failed:${failed}`)
  if (processing > 0) {
    console.log('Some recordings are still transcribing on Twilio — re-run to resume (no double charge; SIDs are stored).')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
