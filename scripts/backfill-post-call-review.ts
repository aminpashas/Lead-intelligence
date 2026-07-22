/**
 * Backfill post-call review for calls the live webhook never reviewed.
 *
 * WHY THIS EXISTS
 * ---------------
 * `runPostCallReview` used to be reachable from exactly one place: the Retell
 * webhook at /api/voice/events. When that webhook was never delivered, the
 * /api/cron/voice-reconcile sweep healed the voice_calls ROW (status, transcript,
 * recording) but deliberately ran nothing else — so the review never happened.
 *
 * The consequence was silent and expensive: review is the only producer of the
 * `broken_promise` / `missed_booking` findings that open a human_tasks work item
 * and fire an admin escalation. A dropped webhook meant the AI could promise a
 * patient a callback and NOBODY was ever told. Every cron-rescued call in the
 * table sat at review_status = null.
 *
 * The cron now runs review itself, so this class of gap stops growing. This
 * one-shot closes the calls that already fell through.
 *
 * SHARES THE LIVE LOGIC
 * ---------------------
 * Imports `runPostCallReview` and `normalizeCallOutcome` from
 * src/lib/voice/post-call-review — the exact functions the webhook and the cron
 * call — so a backfilled verdict is indistinguishable from a live one.
 *
 * IDEMPOTENT / SAFE TO RE-RUN
 * ---------------------------
 * Only touches rows whose review_status is null or 'pending'; a settled verdict is
 * never re-graded. Tasks are deduped by `call_review:<callId>` inside
 * createHumanTask, so re-running refreshes the existing work item rather than
 * stacking duplicates. Review is INTERNAL-ONLY — it writes outcome/flags, a
 * human_task, an escalation and improvement tickets. It sends the patient nothing,
 * which is what makes reviewing a weeks-old call safe.
 *
 * COST
 * ----
 * One Haiku call per reviewed transcript. Dry run (the default) reports how many
 * calls qualify before you commit.
 *
 * Usage:
 *   npx tsx scripts/backfill-post-call-review.ts                  # dry run: list candidates
 *   npx tsx scripts/backfill-post-call-review.ts --apply          # review all candidates
 *   npx tsx scripts/backfill-post-call-review.ts --apply --limit 5
 *   npx tsx scripts/backfill-post-call-review.ts --apply --call <voice_calls.id>
 *   npx tsx scripts/backfill-post-call-review.ts --apply --all-unreviewed
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import {
  runPostCallReview,
  normalizeCallOutcome,
  MIN_REVIEW_TRANSCRIPT_CHARS,
} from '../src/lib/voice/post-call-review'
import type { VoiceCallOutcome } from '../src/types/database'

const APPLY = process.argv.includes('--apply')
// Default scope is the cron-rescued population — the calls this bug actually hit.
// --all-unreviewed widens to every completed call still lacking a verdict.
const ALL_UNREVIEWED = process.argv.includes('--all-unreviewed')

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null
}
const LIMIT = argValue('--limit') ? Math.max(1, parseInt(argValue('--limit')!, 10)) : Infinity
const ONE_CALL = argValue('--call')

function req(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`Missing env: ${name}`)
    process.exit(1)
  }
  return v
}

if (APPLY && !process.env.ANTHROPIC_API_KEY) {
  console.error('Missing env: ANTHROPIC_API_KEY (review is a Claude call)')
  process.exit(1)
}

const supabase = createClient(req('NEXT_PUBLIC_SUPABASE_URL'), req('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false },
})

type Row = {
  id: string
  organization_id: string | null
  lead_id: string | null
  conversation_id: string | null
  retell_call_id: string | null
  direction: string | null
  transcript: string | null
  duration_seconds: number | null
  outcome: string | null
  review_status: string | null
  started_at: string | null
  metadata: Record<string, unknown> | null
}

async function loadCandidates(): Promise<Row[]> {
  let q = supabase
    .from('voice_calls')
    .select(
      'id, organization_id, lead_id, conversation_id, retell_call_id, direction, ' +
        'transcript, duration_seconds, outcome, review_status, started_at, metadata'
    )
    .eq('status', 'completed')
    .or('review_status.is.null,review_status.eq.pending')
    .order('started_at', { ascending: false })
    .limit(500)

  if (ONE_CALL) q = q.eq('id', ONE_CALL)
  else if (!ALL_UNREVIEWED) q = q.eq('metadata->>reconciled_by_cron', 'true')

  const { data, error } = await q
  if (error) throw new Error(`candidate query failed: ${error.message}`)
  // PostgREST can't infer a row shape through .or(), so it widens to an error union.
  return (data ?? []) as unknown as Row[]
}

async function main() {
  const candidates = await loadCandidates()

  // A transcript too short to review has nothing to grade; runPostCallReview would
  // bail internally, so filter here to keep the reported counts honest.
  const eligible = candidates.filter(
    (r) => (r.transcript || '').trim().length >= MIN_REVIEW_TRANSCRIPT_CHARS
  )
  const tooShort = candidates.length - eligible.length
  const batch = eligible.slice(0, LIMIT === Infinity ? undefined : LIMIT)

  console.log(
    `Scope: ${ONE_CALL ? `call ${ONE_CALL}` : ALL_UNREVIEWED ? 'ALL unreviewed completed calls' : 'cron-rescued calls'}`
  )
  console.log(
    `Candidates: ${candidates.length}  ·  reviewable: ${eligible.length}  ·  ` +
      `transcript too short: ${tooShort}  ·  this run: ${batch.length}`
  )

  if (!APPLY) {
    for (const r of batch) {
      console.log(
        `  [dry] ${r.id}  ${r.started_at?.slice(0, 16) ?? '—'}  ${r.direction ?? '?'}  ` +
          `outcome=${r.outcome ?? 'null'}  ${(r.transcript || '').length}c  lead=${r.lead_id ?? '—'}`
      )
    }
    console.log('\nDry run — nothing written. Re-run with --apply to review.')
    return
  }

  let reviewed = 0
  let skipped = 0
  for (const r of batch) {
    // Review hangs its human_task / escalation off the org; without one there is
    // nowhere to file the finding, and runPostCallReview returns early anyway.
    if (!r.organization_id) {
      console.log(`  skip ${r.id} — unattributed (no organization_id)`)
      skipped++
      continue
    }

    const disconnectionReason =
      ((r.metadata?.disconnection_reason as string) ?? null) ||
      ((r.metadata?.call_analysis as Record<string, unknown> | undefined)?.disconnection_reason as
        | string
        | undefined) ||
      null

    // Re-derive rather than trusting the stored value: these rows were written by
    // the OLD reconciler, whose outcome could be a raw disconnect string or a false
    // appointment_booked. Passing that in as ground truth would bias the reviewer.
    const currentOutcome = normalizeCallOutcome({
      disconnectionReason,
      callSuccessful:
        ((r.metadata?.call_analysis as Record<string, unknown> | undefined)?.call_successful as
          | boolean
          | undefined) ?? null,
      userSentiment:
        ((r.metadata?.call_analysis as Record<string, unknown> | undefined)?.user_sentiment as
          | string
          | undefined) ?? null,
      appointmentBooked: false, // the very flag that mis-fired; let the AI decide
      durationSeconds: r.duration_seconds ?? 0,
      hasTranscript: (r.transcript || '').trim().length > 0,
    })

    await runPostCallReview(supabase, {
      callId: r.id,
      organizationId: r.organization_id,
      leadId: r.lead_id,
      conversationId: r.conversation_id,
      retellCallId: r.retell_call_id ?? r.id,
      direction: r.direction === 'outbound' ? 'outbound' : 'inbound',
      transcript: r.transcript || '',
      durationSeconds: r.duration_seconds ?? 0,
      disconnectionReason,
      currentOutcome: currentOutcome as VoiceCallOutcome | null,
    })

    const { data: after } = await supabase
      .from('voice_calls')
      .select('review_status, outcome, review_flags')
      .eq('id', r.id)
      .maybeSingle()

    const flags = Array.isArray(after?.review_flags) ? after!.review_flags.length : 0
    console.log(
      `  ✓ ${r.id}  review=${after?.review_status ?? '?'}  ` +
        `outcome=${r.outcome ?? 'null'} → ${after?.outcome ?? 'null'}  issues=${flags}`
    )
    reviewed++
  }

  console.log(`\nDone. reviewed=${reviewed} skipped=${skipped}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
