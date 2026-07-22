/**
 * Post-call review — every completed call gets (1) a valid, human-readable
 * outcome, (2) an AI issue scan whose findings escalate to human admins, and
 * (3) engineering-facing "improvement tickets" for technical problems, shown
 * in the Agency admin panel (/agency/ai-improvements).
 *
 * Three layers, in order of trust:
 *   • normalizeCallOutcome() — deterministic mapping of Retell signals into
 *     the voice_calls.outcome CHECK vocabulary. This is what the finalization
 *     write uses; it can never violate the constraint.
 *   • detectSystemFindings() — deterministic technical checks that need no
 *     model (empty transcript on an answered call, unattributed call, …).
 *   • reviewCallWithAI() — one Claude call over the transcript that refines
 *     the outcome and surfaces patient-facing issues + technical findings.
 *
 * runPostCallReview() orchestrates the three and fans out: voice_calls gets
 * review_status/review_flags for the Call Center list, flagged calls create a
 * human_tasks work item (critical ones also fire createEscalation → immediate
 * admin SMS/email), and technical findings upsert ai_improvement_tickets
 * deduped by fingerprint.
 *
 * Fail-soft like every other post-call step: nothing in here may throw into
 * the Retell webhook.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { VoiceCallOutcome } from '@/types/database'
import { createHumanTask } from '@/lib/automation/tasks'
import { createEscalation, type EscalationReason } from '@/lib/autopilot/escalation'
import { notifyInboundMessage } from '@/lib/notifications/staff-notify'
import { logger } from '@/lib/logger'

const REVIEW_MODEL = 'claude-haiku-4-5'
const MAX_OUTPUT_TOKENS = 1200
/** Below this there is no conversation to review (mirrors call-summary.ts). */
export const MIN_REVIEW_TRANSCRIPT_CHARS = 120

// ═══════════════════════════════════════════════════════════════
// 1. DETERMINISTIC OUTCOME NORMALIZATION
// ═══════════════════════════════════════════════════════════════

export type NormalizeOutcomeInput = {
  /** Retell disconnection_reason (raw). */
  disconnectionReason?: string | null
  /** Retell call_analysis.call_successful. */
  callSuccessful?: boolean | null
  /** Retell call_analysis.user_sentiment ('Positive' | 'Neutral' | 'Negative'). */
  userSentiment?: string | null
  /** extractFromTranscript().appointmentBooked */
  appointmentBooked?: boolean
  durationSeconds?: number
  hasTranscript?: boolean
  /** Twilio AMD verdict (voice_calls.answered_by). Only set on browser/bridge calls. */
  answeredBy?: string | null
}

/** disconnection_reason values that mean the platform (not the patient) failed. */
const TECHNICAL_DISCONNECTS = new Set([
  'dial_failed',
  'invalid_destination',
  'concurrency_limit_reached',
  'no_valid_payment',
  'telephony_provider_permission_denied',
  'telephony_provider_unavailable',
])

/**
 * Twilio AnsweredBy values that mean a machine picked up. `unknown` is excluded
 * deliberately — it means AMD gave up, not that it found a machine, and treating
 * it as voicemail would suppress review on real conversations.
 */
const MACHINE_ANSWERED_BY = new Set([
  'machine_start',
  'machine_end_beep',
  'machine_end_silence',
  'machine_end_other',
])

/** True when Twilio's AMD verdict says a machine, not a person, answered. */
export function isMachineAnsweredBy(answeredBy?: string | null): boolean {
  return MACHINE_ANSWERED_BY.has((answeredBy || '').toLowerCase())
}

/**
 * Map raw Retell signals onto the voice_calls.outcome CHECK vocabulary.
 * Returns null only for a connected call with a transcript that genuinely
 * needs the AI pass to classify — the UI renders that as "Needs Review".
 */
export function normalizeCallOutcome(input: NormalizeOutcomeInput): VoiceCallOutcome | null {
  const reason = (input.disconnectionReason || '').toLowerCase()

  if (input.appointmentBooked) return 'appointment_booked'
  if (reason === 'call_transfer') return 'transferred'
  // Voicemail from either path: Retell reports it on the AI leg, Twilio AMD on the
  // browser/bridge leg. Both rank below a booking/transfer, which are hard proof a
  // human was on the line and AMD simply mis-fired on a slow greeting.
  if (reason === 'voicemail_reached' || reason === 'machine_detected') return 'voicemail_left'
  if (isMachineAnsweredBy(input.answeredBy)) return 'voicemail_left'
  if (['dial_no_answer', 'dial_busy', 'no_answer', 'busy'].includes(reason)) return 'no_answer'
  if (TECHNICAL_DISCONNECTS.has(reason) || reason.startsWith('error')) return 'technical_failure'

  if (input.callSuccessful === true) return 'interested'
  if (input.userSentiment === 'Negative') return 'not_interested'

  const connected = (input.durationSeconds ?? 0) > 0
  if (!connected) return 'no_answer'
  // Connected but no words captured: the transcript pipeline broke, not the call.
  if (!input.hasTranscript) return 'technical_failure'
  // Connected with a transcript but no deterministic signal → AI refines.
  return null
}

// ═══════════════════════════════════════════════════════════════
// 2. TYPES — review result
// ═══════════════════════════════════════════════════════════════

export type CallIssueCategory =
  | 'compliance'
  | 'wrong_information'
  | 'missed_booking'
  | 'negative_experience'
  | 'broken_promise'
  | 'call_dropped'
  | 'other'

export type CallIssue = {
  category: CallIssueCategory
  severity: 'critical' | 'warning'
  summary: string
  /** Short quote from the transcript backing the finding. */
  evidence: string
  recommended_action: string
}

export type TechnicalFindingCategory =
  | 'agent_logic'
  | 'prompt'
  | 'telephony'
  | 'data_gap'
  | 'integration'
  | 'other'

export type TechnicalFinding = {
  category: TechnicalFindingCategory
  severity: 'critical' | 'warning' | 'info'
  title: string
  summary: string
  recommendation: string
  action_plan: string[]
  /** Stable dedupe key; AI findings get one derived from category+title. */
  fingerprint?: string
}

export type CallReview = {
  outcome: VoiceCallOutcome | null
  outcome_confidence: 'high' | 'medium' | 'low'
  issues: CallIssue[]
  technical_findings: TechnicalFinding[]
}

// ═══════════════════════════════════════════════════════════════
// 3. AI REVIEW
// ═══════════════════════════════════════════════════════════════

const OUTCOME_VALUES: VoiceCallOutcome[] = [
  'appointment_booked', 'callback_requested', 'interested', 'not_interested',
  'wrong_number', 'do_not_call', 'voicemail_left', 'no_answer',
  'technical_failure', 'transferred',
]

const REVIEW_PROMPT = `You are a QA reviewer for an AI voice agent at a dental implant practice. You are given the transcript of a completed phone call plus call metadata. Output STRICT JSON only — no prose, no markdown fences.

Schema:
{
  "outcome": one of ${JSON.stringify(OUTCOME_VALUES)} — the single best classification of how the call ended for the practice,
  "outcome_confidence": "high" | "medium" | "low",
  "issues": [
    {
      "category": "compliance" | "wrong_information" | "missed_booking" | "negative_experience" | "broken_promise" | "call_dropped" | "other",
      "severity": "critical" | "warning",
      "summary": "one sentence a manager can act on",
      "evidence": "short verbatim quote from the transcript",
      "recommended_action": "the single most useful next step for a human"
    }
  ],
  "technical_findings": [
    {
      "category": "agent_logic" | "prompt" | "telephony" | "data_gap" | "integration" | "other",
      "severity": "critical" | "warning" | "info",
      "title": "short stable title (same problem => same title)",
      "summary": "what went wrong technically",
      "recommendation": "what the engineering team should change",
      "action_plan": ["step 1", "step 2"]
    }
  ]
}

Issue guidance (patient-facing — these page a human admin, so only flag REAL problems):
- compliance: quoted prices/financing approvals/medical advice the AI must not give, HIPAA/TCPA problems, recording-disclosure gaps.
- wrong_information: the agent stated something factually wrong or invented details.
- missed_booking: the caller clearly wanted to book and no appointment or concrete next step was secured.
- negative_experience: the caller became frustrated or angry, the agent looped/repeated itself, talked over the caller, or ignored what they said.
- broken_promise: the agent promised a text/email/callback/transfer that the transcript gives no sign was set up.
- call_dropped: the conversation cut off mid-flow before a natural close.
- severity "critical" = a human should intervene TODAY (compliance breach, furious patient, lost booking that was clearly wanted). Otherwise "warning".

Technical findings are for the engineering team (agent looped due to prompt gap, misheard/garbled audio, missing lead context it should have had, a tool/transfer that failed). Keep titles STABLE and generic so repeats dedupe — e.g. "Agent repeats pricing deflection verbatim", not a title containing the caller's name.

Empty arrays are fine — most calls are clean. Never invent problems.`

function getAnthropic() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
}

/** Pull the first balanced JSON object out of a model reply (defensive vs. stray prose). */
export function parseCallReview(raw: string): CallReview | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as Partial<CallReview>
    const outcome = OUTCOME_VALUES.includes(obj.outcome as VoiceCallOutcome)
      ? (obj.outcome as VoiceCallOutcome)
      : null
    const issues: CallIssue[] = (Array.isArray(obj.issues) ? obj.issues : [])
      .filter((i): i is CallIssue => !!i && typeof i.summary === 'string')
      .map((i) => ({
        category: i.category ?? 'other',
        severity: i.severity === 'critical' ? 'critical' : 'warning',
        summary: String(i.summary),
        evidence: typeof i.evidence === 'string' ? i.evidence : '',
        recommended_action: typeof i.recommended_action === 'string' ? i.recommended_action : '',
      }))
    const technical: TechnicalFinding[] = (Array.isArray(obj.technical_findings) ? obj.technical_findings : [])
      .filter((f): f is TechnicalFinding => !!f && typeof f.title === 'string')
      .map((f) => ({
        category: f.category ?? 'other',
        severity: f.severity === 'critical' || f.severity === 'info' ? f.severity : 'warning',
        title: String(f.title),
        summary: typeof f.summary === 'string' ? f.summary : '',
        recommendation: typeof f.recommendation === 'string' ? f.recommendation : '',
        action_plan: Array.isArray(f.action_plan) ? f.action_plan.map(String) : [],
      }))
    return {
      outcome,
      outcome_confidence:
        obj.outcome_confidence === 'high' || obj.outcome_confidence === 'medium'
          ? obj.outcome_confidence
          : 'low',
      issues,
      technical_findings: technical,
    }
  } catch {
    return null
  }
}

export type ReviewCallInput = {
  transcript: string
  direction: 'inbound' | 'outbound'
  durationSeconds: number
  disconnectionReason?: string | null
  /** Deterministic outcome already stamped on the record (context for the model). */
  currentOutcome?: VoiceCallOutcome | null
}

/**
 * Outcome of one review attempt. The distinction between `failed` and `skipped`
 * is load-bearing: a call the model never got to look at MUST NOT be recorded as
 * reviewed-and-clean. Collapsing both into `null` meant an Anthropic outage (or a
 * spend cap) silently stamped review_status='clear' across every call it touched,
 * burying real broken_promise findings behind a green check.
 */
export type ReviewAttempt =
  | { status: 'ok'; review: CallReview }
  /** Nothing to grade — transcript below the review floor. A settled, honest state. */
  | { status: 'skipped' }
  /** The model call or its parse failed. The call is UNREVIEWED; retry it later. */
  | { status: 'failed'; reason: string }

/** One Claude pass over the transcript. Never throws. */
export async function reviewCallWithAI(input: ReviewCallInput): Promise<ReviewAttempt> {
  const text = (input.transcript || '').trim()
  if (text.length < MIN_REVIEW_TRANSCRIPT_CHARS) return { status: 'skipped' }
  try {
    const response = await getAnthropic().messages.create({
      model: REVIEW_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: REVIEW_PROMPT,
      messages: [{
        role: 'user',
        content:
          `Call metadata:\n` +
          `- direction: ${input.direction}\n` +
          `- duration_seconds: ${input.durationSeconds}\n` +
          `- disconnection_reason: ${input.disconnectionReason || 'unknown'}\n` +
          `- current_outcome: ${input.currentOutcome || 'unclassified'}\n\n` +
          `Transcript:\n\n${text.slice(0, 30000)}`,
      }],
    })
    const raw = response.content
      .filter((c) => c.type === 'text')
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('\n')
    const parsed = parseCallReview(raw)
    // Unparseable output is a failed review, not a clean one — the model may well
    // have found something and simply framed it wrong.
    return parsed
      ? { status: 'ok', review: parsed }
      : { status: 'failed', reason: 'unparseable model output' }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    logger.warn('PostCallReview: AI review failed', { error: reason })
    return { status: 'failed', reason }
  }
}

// ═══════════════════════════════════════════════════════════════
// 4. DETERMINISTIC SYSTEM CHECKS
// ═══════════════════════════════════════════════════════════════

export type SystemCheckInput = {
  attributed: boolean
  durationSeconds: number
  hasTranscript: boolean
  disconnectionReason?: string | null
  retellFetchOk: boolean
  /** Suppresses the empty-transcript check — see below. */
  isVoicemail?: boolean
}

/** Technical findings that need no model — pure signal inspection. */
export function detectSystemFindings(input: SystemCheckInput): TechnicalFinding[] {
  const findings: TechnicalFinding[] = []
  const reason = (input.disconnectionReason || '').toLowerCase()

  if (!input.retellFetchOk) {
    findings.push({
      category: 'integration',
      severity: 'critical',
      title: 'Retell get-call fetch failed after call end',
      summary: 'The post-call webhook could not fetch full call data from Retell, so the record may be missing transcript/recording.',
      recommendation: 'Add retry with backoff on the Retell get-call fetch and alert when it fails repeatedly.',
      action_plan: [
        'Check Retell API status and the RETELL_API_KEY validity',
        'Add a retry (3x, exponential backoff) around the get-call fetch in /api/voice/events',
        'Backfill affected calls via the Retell API once connectivity is restored',
      ],
      fingerprint: 'system:integration:retell_fetch_failed',
    })
  }

  // A voicemail is indistinguishable from a broken transcript pipeline by these
  // signals alone — both are "long call, no words". Only the AMD/Retell verdict
  // tells them apart, so a known voicemail is never evidence of a platform bug.
  if (input.durationSeconds > 20 && !input.hasTranscript && !input.isVoicemail) {
    findings.push({
      category: 'telephony',
      severity: 'critical',
      title: 'Answered call produced no transcript',
      summary: `A call lasting ${input.durationSeconds}s ended with an empty transcript — audio or transcription pipeline failure.`,
      recommendation: 'Investigate the Retell transcription pipeline / audio path for this agent and add monitoring on transcript-empty rates.',
      action_plan: [
        'Pull the call recording from Retell and confirm audio is present',
        'Check the Retell agent transcription settings',
        'Add a daily metric: % of answered calls with empty transcripts',
      ],
      fingerprint: 'system:telephony:empty_transcript_answered_call',
    })
  }

  if (!input.attributed) {
    findings.push({
      category: 'data_gap',
      severity: 'warning',
      title: 'Call could not be attributed to an org/lead',
      summary: 'A completed call had no metadata and no phone-hash match, so it was not linked to any lead or organization.',
      recommendation: 'Ensure SIP-trunk numbers are registered as voice_outbound_caller_id and inbound pre-registration covers all lines.',
      action_plan: [
        'List recent unattributed retell_call_ids from webhook logs',
        'Verify each practice number is configured in organizations.voice_outbound_caller_id',
        'Consider creating a lead automatically for unknown inbound callers',
      ],
      fingerprint: 'system:data_gap:unattributed_call',
    })
  }

  if (TECHNICAL_DISCONNECTS.has(reason) || reason.startsWith('error')) {
    findings.push({
      category: 'telephony',
      severity: 'warning',
      title: `Call ended with platform error: ${reason}`,
      summary: `Retell reported disconnection_reason="${reason}" — the platform, not the caller, ended this call.`,
      recommendation: 'Track error-class disconnections per day; sustained occurrences usually mean trunk/ACL or concurrency configuration drift.',
      action_plan: [
        'Check the Twilio SIP trunk termination ACL and credentials',
        'Review Retell concurrency limits vs. campaign dial rate',
      ],
      fingerprint: `system:telephony:disconnect_${reason}`,
    })
  }

  return findings
}

// ═══════════════════════════════════════════════════════════════
// 5. IMPROVEMENT TICKETS (dedupe-by-fingerprint upsert)
// ═══════════════════════════════════════════════════════════════

const LIVE_TICKET_STATUSES = ['open', 'acknowledged', 'in_progress']

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80)
}

/**
 * Insert a finding as an ai_improvement_tickets row, or bump
 * occurrence_count/last_seen_at on the live ticket with the same fingerprint.
 * Fail-soft.
 */
export async function raiseImprovementTicket(
  supabase: SupabaseClient,
  params: {
    organizationId: string | null
    source: 'post_call_review' | 'system_check'
    finding: TechnicalFinding
    evidence: Record<string, unknown>
  }
): Promise<void> {
  const { finding } = params
  const fingerprint =
    finding.fingerprint ?? `ai:${finding.category}:${slugify(finding.title)}`
  try {
    const { data: existing } = await supabase
      .from('ai_improvement_tickets')
      .select('id, occurrence_count, evidence')
      .eq('fingerprint', fingerprint)
      .in('status', LIVE_TICKET_STATUSES)
      .limit(1)
      .maybeSingle()

    if (existing) {
      const priorCalls = Array.isArray((existing.evidence as Record<string, unknown>)?.call_ids)
        ? ((existing.evidence as Record<string, unknown>).call_ids as unknown[])
        : []
      const newCallId = params.evidence.call_id
      await supabase
        .from('ai_improvement_tickets')
        .update({
          occurrence_count: (existing.occurrence_count || 1) + 1,
          last_seen_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          evidence: {
            ...(existing.evidence as Record<string, unknown>),
            // Keep a rolling window of the most recent 10 triggering calls.
            call_ids: [...priorCalls, newCallId].filter(Boolean).slice(-10),
            last: params.evidence,
          },
        })
        .eq('id', existing.id)
      return
    }

    const { error } = await supabase.from('ai_improvement_tickets').insert({
      organization_id: params.organizationId,
      source: params.source,
      category: finding.category,
      severity: finding.severity,
      title: finding.title,
      summary: finding.summary || null,
      recommendation: finding.recommendation || null,
      action_plan: finding.action_plan,
      evidence: {
        ...params.evidence,
        call_ids: params.evidence.call_id ? [params.evidence.call_id] : [],
      },
      fingerprint,
    })
    // Dedupe race: a concurrent webhook inserted the same fingerprint first —
    // that row already represents this finding, so losing the race is fine.
    if (error && error.code !== '23505') {
      logger.warn('PostCallReview: ticket insert failed', { fingerprint, error: error.message })
    }
  } catch (err) {
    logger.warn('PostCallReview: raiseImprovementTicket threw', {
      fingerprint,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// ═══════════════════════════════════════════════════════════════
// 6. ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════

/** Map a patient-facing issue category onto the escalations.reason vocabulary. */
function toEscalationReason(category: CallIssueCategory): EscalationReason {
  switch (category) {
    case 'compliance':
    case 'wrong_information':
      return 'compliance_flag'
    case 'negative_experience':
      return 'sentiment_drop'
    default:
      return 'agent_failure'
  }
}

export type RunPostCallReviewInput = {
  /** voice_calls.id — null when the call could not be attributed/finalized. */
  callId: string | null
  organizationId: string | null
  leadId: string | null
  conversationId: string | null
  retellCallId: string
  direction: 'inbound' | 'outbound'
  transcript: string
  durationSeconds: number
  disconnectionReason?: string | null
  /** Outcome the deterministic normalizer stamped at finalization. */
  currentOutcome: VoiceCallOutcome | null
  retellFetchOk?: boolean
}

/**
 * Full post-call review pipeline. Call AFTER the voice_calls row is finalized;
 * everything here is best-effort and never throws.
 */
export async function runPostCallReview(
  supabase: SupabaseClient,
  input: RunPostCallReviewInput
): Promise<void> {
  try {
    const evidence = {
      call_id: input.callId,
      retell_call_id: input.retellCallId,
      organization_id: input.organizationId,
      lead_id: input.leadId,
      direction: input.direction,
      duration_seconds: input.durationSeconds,
      disconnection_reason: input.disconnectionReason || null,
    }

    const isVoicemail = input.currentOutcome === 'voicemail_left'

    // ── System checks (always run — they don't need a transcript) ──
    const systemFindings = detectSystemFindings({
      attributed: !!(input.organizationId && input.callId),
      durationSeconds: input.durationSeconds,
      hasTranscript: input.transcript.trim().length > 0,
      disconnectionReason: input.disconnectionReason,
      retellFetchOk: input.retellFetchOk ?? true,
      isVoicemail,
    })
    for (const finding of systemFindings) {
      await raiseImprovementTicket(supabase, {
        organizationId: input.organizationId,
        source: 'system_check',
        finding,
        evidence,
      })
    }

    // ── AI review (needs a transcript + an attributed call to act on) ──
    if (!input.callId || !input.organizationId) return

    // Voicemail is a settled outcome, not a defect: the deterministic layer already
    // classified it, and there is no patient conversation to grade. Reviewing it
    // would spend a Haiku call per dial and — since any issue it invented would
    // open a human_task, and a "critical" one would fire an urgent admin SMS —
    // page the practice on routine machine answers. Mark it clear and stop.
    // System findings above still ran, so genuine platform faults are not lost.
    if (isVoicemail) {
      await supabase.from('voice_calls').update({ review_status: 'clear' }).eq('id', input.callId)
      logger.info('PostCallReview: voicemail — skipped AI review', { call_id: input.callId })
      return
    }

    const attempt = await reviewCallWithAI({
      transcript: input.transcript,
      direction: input.direction,
      durationSeconds: input.durationSeconds,
      disconnectionReason: input.disconnectionReason,
      currentOutcome: input.currentOutcome,
    })

    if (attempt.status === 'failed') {
      // The model never rendered a verdict. Leave the call PENDING — never 'clear'
      // — so it stays visible as unreviewed and a later sweep can retry it. Marking
      // it clear here is how an API outage or a spend cap turns into a silent
      // amnesty on every call it touches.
      await supabase
        .from('voice_calls')
        .update({ review_status: 'pending' })
        .eq('id', input.callId)
      logger.warn('PostCallReview: left pending — review did not run', {
        call_id: input.callId,
        reason: attempt.reason,
      })
      return
    }

    if (attempt.status === 'skipped') {
      // Genuinely nothing to grade (transcript below the floor). Settled: mark clear
      // when the deterministic layer classified it, else leave it for the UI.
      await supabase
        .from('voice_calls')
        .update({ review_status: input.currentOutcome ? 'clear' : 'pending' })
        .eq('id', input.callId)
      return
    }

    const review = attempt.review

    const hasCritical = review.issues.some((i) => i.severity === 'critical')
    const reviewStatus = review.issues.length === 0 ? 'clear' : hasCritical ? 'escalated' : 'flagged'

    // ── Write outcome refinement + flags back onto the call ──
    const callUpdate: Record<string, unknown> = {
      review_status: reviewStatus,
      review_flags: review.issues,
    }
    // The AI outcome only fills gaps or overrides with confidence — the
    // deterministic technical_failure/no_answer signals stay authoritative.
    if (
      review.outcome &&
      (input.currentOutcome === null ||
        (review.outcome_confidence === 'high' &&
          !['technical_failure', 'transferred'].includes(input.currentOutcome)))
    ) {
      callUpdate.outcome = review.outcome
    }
    await supabase.from('voice_calls').update(callUpdate).eq('id', input.callId)

    // ── Patient-facing issues → human work queue + admin escalation ──
    if (review.issues.length > 0) {
      const top = [...review.issues].sort((a) =>
        a.severity === 'critical' ? -1 : 1
      )[0]
      const detail = review.issues
        .map((i) => `[${i.severity.toUpperCase()} · ${i.category}] ${i.summary}\n→ ${i.recommended_action}`)
        .join('\n\n')

      const { taskId } = await createHumanTask(supabase, {
        organization_id: input.organizationId,
        kind: 'call_review',
        title: `Call review: ${top.summary.slice(0, 120)}`,
        detail,
        source: 'post_call_review',
        lead_id: input.leadId,
        conversation_id: input.conversationId,
        assigned_role: 'admin',
        // Critical issues carry a tight SLA so the takeover cron notices too.
        due_at: hasCritical ? new Date(Date.now() + 30 * 60 * 1000).toISOString() : null,
        dedupe_key: `call_review:${input.callId}`,
        metadata: { call_id: input.callId, retell_call_id: input.retellCallId, issues: review.issues },
      })

      if (hasCritical && input.conversationId && input.leadId) {
        // Immediate admin SMS/email via the existing escalation spine.
        await createEscalation(supabase, {
          organization_id: input.organizationId,
          conversation_id: input.conversationId,
          lead_id: input.leadId,
          reason: toEscalationReason(top.category),
          ai_notes: `Post-call review flagged: ${top.summary}${top.evidence ? ` — "${top.evidence}"` : ''}`,
          agent_type: 'setter',
          priority: 'urgent',
        })
      }

      if (input.conversationId && input.leadId) {
        // Slack/push ping through the shared noise-controlled channel.
        await notifyInboundMessage(supabase, {
          organizationId: input.organizationId,
          conversationId: input.conversationId,
          leadId: input.leadId,
          messagePreview: `Call flagged (${top.severity}): ${top.summary}`,
          kind: 'task',
          taskId: taskId ?? undefined,
          channels: hasCritical ? ['slack', 'push'] : ['slack'],
        })
      }
    }

    // ── AI technical findings → improvement tickets ──
    for (const finding of review.technical_findings) {
      await raiseImprovementTicket(supabase, {
        organizationId: input.organizationId,
        source: 'post_call_review',
        finding,
        evidence,
      })
    }

    logger.info('PostCallReview: complete', {
      call_id: input.callId,
      review_status: reviewStatus,
      issues: review.issues.length,
      technical_findings: review.technical_findings.length + systemFindings.length,
    })
  } catch (err) {
    logger.warn('PostCallReview: runPostCallReview threw (non-fatal)', {
      retell_call_id: input.retellCallId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
