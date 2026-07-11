# Call Outcome Clarity + Post-Call AI Review, Admin Escalation & AI Improvement Tickets

**Date:** 2026-07-11
**Branch:** feat/pipeline-stage-restructure
**Status:** Approved for implementation (autonomous session — decisions grounded in codebase exploration)

## Problem

1. **Call outcomes are unclear in the call list.** The Retell webhook
   (`src/app/api/voice/events/route.ts`) writes raw `disconnection_reason`
   strings (`user_hangup`, `dial_no_answer`, …) into `voice_calls.outcome`,
   which violates the column's CHECK constraint (only 10 curated values are
   allowed). The finalization UPDATE fails silently, so most calls show no
   outcome badge in the Call Center list.
2. **No post-call issue detection.** Nothing analyzes a finished call for
   problems (compliance risk, wrong info given, missed booking, angry patient,
   dropped call). Issues die silently in transcripts.
3. **No feedback loop to engineering.** When the AI/telephony stack
   misbehaves (empty transcript on an answered call, unattributed call, tool
   failure), nobody files anything. The agency admin panel has no view of
   systemic technical problems.

## Goals

- Every completed call shows a clear, valid outcome badge in the call list;
  calls the system can't classify show **Needs Review** instead of nothing.
- Post-call AI analysis flags patient-facing issues; **critical** issues
  immediately escalate to org admins (existing `createEscalation` → admin
  SMS/email) and every flagged call creates a `human_tasks` work-queue item.
- Technical findings (AI-detected + deterministic system checks) raise
  **AI improvement tickets** with a recommendation and step-by-step action
  plan, deduped by fingerprint, visible in the **Agency admin panel** at
  `/agency/ai-improvements`.

## Design

### 1. Outcome normalization (deterministic, fixes the CHECK bug)

New `normalizeCallOutcome()` in `src/lib/voice/post-call-review.ts` maps
Retell signals → the `VoiceCallOutcome` vocabulary:

- `appointmentBooked` → `appointment_booked`
- `call_transfer` → `transferred`; `voicemail_reached`/`machine_detected` → `voicemail_left`
- `dial_no_answer`/`dial_busy` → `no_answer`
- `dial_failed`/`error*`/`concurrency_limit_reached`/`invalid_destination` → `technical_failure`
- `call_analysis.call_successful` → `interested`; negative sentiment → `not_interested`
- connected + transcript but unclassifiable → `null` (AI review refines; UI
  shows **Needs Review**); connected but NO transcript → `technical_failure`
  (transcript pipeline broke — also raises a system ticket)

Used by both the Retell webhook and `processCallEnd()` in
`call-manager.ts` (which currently casts `busy` — an invalid value).

### 2. Post-call review module (`src/lib/voice/post-call-review.ts`)

`runPostCallReview()` — orchestrator called from the webhook after
finalization, isolated so failures never strand the record. Never throws.

- **AI review** (`claude-haiku-4-5`, strict JSON, mirrors `call-summary.ts`
  parsing posture): returns refined `outcome`, `issues[]` (patient-facing) and
  `technical_findings[]` (engineering-facing).
  - Issue categories: `compliance`, `wrong_information`, `missed_booking`,
    `negative_experience`, `broken_promise`, `call_dropped`, `other`;
    severity `critical` | `warning`; each with summary, evidence quote and
    recommended action.
  - Technical categories: `agent_logic`, `prompt`, `telephony`, `data_gap`,
    `integration`; each with recommendation + action-plan steps.
- **Deterministic system checks** (no model needed): answered-but-empty
  transcript, unattributed call, unmapped disconnection reason, error-class
  disconnections.
- **Writes back to `voice_calls`**: refined `outcome` (only if currently
  null/unclear), `review_status` (`clear` | `flagged` | `escalated`),
  `review_flags` (jsonb issue list for the UI).
- **Escalation path**:
  - Any issue → `createHumanTask(kind: 'call_review', dedupe: call_review:<id>)`
    routed via `resolveAssignee` (assignee → role pool → org admins).
  - Critical issue → additionally `createEscalation(priority: 'urgent')`
    (existing module: escalation row + immediate admin SMS/email) and
    `notifyInboundMessage(kind: 'task', channels: ['slack','push'])` when a
    conversation exists.
- **Ticket path**: `raiseImprovementTicket()` upserts into
  `ai_improvement_tickets` by fingerprint — repeats increment
  `occurrence_count` + `last_seen_at` instead of duplicating.

### 3. Migration `20260711190000_call_review_ai_tickets.sql`

- `voice_calls` + `review_status text CHECK (pending|clear|flagged|escalated)`,
  `review_flags jsonb default '[]'`.
- New `ai_improvement_tickets`: org (nullable for unattributed calls), source
  (`post_call_review` | `system_check`), category, severity, title, summary,
  recommendation, `action_plan jsonb`, `evidence jsonb` (call ids…),
  `fingerprint`, `occurrence_count`, `last_seen_at`, status
  (`open|acknowledged|in_progress|resolved|dismissed`), resolution fields.
  Partial unique index on fingerprint over live statuses. RLS: select/update
  for `is_agency_admin()` only; inserts are service-role.
- Extend `human_tasks.kind` CHECK with `call_review` (guarded — table is
  branch-new).

### 4. UI

- **Call Center list** (`call-center-dashboard.tsx`): every completed call
  renders an outcome badge — known outcomes keep their config; unknown/null on
  a completed call renders **Needs Review** (amber). A rose **Flagged /
  Escalated** badge appears when `review_status` says so; the expanded row
  gains an "AI Review" section listing each issue (severity, summary,
  evidence, recommended action).
- **Agency panel** `/agency/ai-improvements` (+ sidebar link under AI
  Platform): KPI cards (open, critical, resolved-this-month), ticket list with
  category/severity badges, occurrence count, recommendation + action plan,
  and status actions (acknowledge / start / resolve / dismiss) via
  `PATCH /api/agency/ai-tickets` (agency-admin-gated like
  `/api/agency/learning/rules`).
- **Tasks list**: add `call_review` to `KIND_META`.

## Error handling

Everything downstream of record finalization is fail-soft (matches existing
posture): AI review failures log and skip; ticket/task/escalation writes catch
and continue. The finalization write itself is now protected from CHECK
violations by the normalizer.

## Testing

- Unit tests for `normalizeCallOutcome` mapping table and review-JSON parsing
  (mirrors `parseCallSummary` tests style) in `src/lib/__tests__/`.
- `npm run build` must pass (type errors block Vercel deploys on main).

## Out of scope

- Retell hosted-agent prompt changes (live agent is dashboard-managed).
- STT for recording-only calls (no provider provisioned).
- Auto-applying AI recommendations to code — tickets are advisory for humans.
