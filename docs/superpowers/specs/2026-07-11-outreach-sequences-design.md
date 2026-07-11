# Unified Outreach Sequences — Design

**Date:** 2026-07-11 · **Branch:** feat/pipeline-stage-restructure

## Goal

One editable model for every automated outreach cadence — new-lead speed-to-lead,
no-answer follow-up, and appointment confirmation/reminders — visible and
modifiable in the AI Command Center, with each step assignable to AI or a human.

## Decisions (confirmed with user)

1. **Fully wired** — editing a sequence changes real send behavior (still behind
   consent gates, quiet hours, `MESSAGING_DRY_RUN`, `FOLLOWUP_SEQUENCES_ENABLED`).
2. **Calls:** AI-owned call steps go out via Retell voice *when voice is enabled*
   (`SEQUENCE_AI_CALLS_ENABLED=true` + `preCallCheck`); otherwise they fall back
   to a human call task. Human-owned call steps always create tasks.
3. **Copy:** AI-composed per lead by the setter agent, guided by a per-step
   `intent`; optional fixed `template_body` override.
4. **Placement:** "Workflows" tab inside the AI Command Center (Settings → AI).

## Data model (`20260711170000_outreach_sequences.sql`)

- `outreach_sequences` — org-scoped; `key` (unique/org), `name`, `trigger`
  (`lead_created` | `appointment`), `anchor` (`enrollment` | `appointment_time`),
  `enabled`, `is_system`, `stop_on_reply`, `stop_on_booking`. Standard RLS.
- `outreach_sequence_steps` — `sequence_id`, `position` (unique/seq),
  `offset_minutes` (negative = before appointment), `channel`
  (`sms`|`email`|`ai_call`|`human_call`|`human_task`), `owner` (`ai`|`human`),
  `condition` (`always`|`unconfirmed`|`confirmed`), `intent`,
  `template_subject`/`template_body`, `enabled`, `kind` (`step`|`speed_to_lead`),
  `metadata` jsonb.
- `follow_up_enrollments.sequence_id` (nullable FK).
- **Seeds** (per existing org, behavior-preserving): `new_lead_follow_up`
  mirrors today's 8-touch cadence + a `speed_to_lead` display step at position 0
  + AI/human call steps; steps that would change today's live behavior ship
  `enabled=false`. `appointment_prep` mirrors 72h email + 24h SMS/email; the
  48h-unconfirmed AI call and 2h-before SMS ship disabled.

## Engine (`src/lib/automation/sequences.ts`)

- Loaders: `loadSequence(orgId, key)`, `loadAllSequences(orgId)` (with steps,
  ordered). Missing rows → code-default fallback so crons never break.
- Pure scheduling: `nextDueEnrollmentStep(steps, enrollment, nowMs)`
  (generalizes `src/lib/followup/sequence.ts` to minute offsets, skips
  `speed_to_lead` display steps and disabled steps);
  `dueAppointmentSteps(steps, apptTimeIso, confirmed, nowMs)` with a catch-up
  cap so old steps don't fire late.
- `executeStep()` dispatch:
  - `owner='human'` or channel `human_call`/`human_task` → `createHumanTask`
    (kind `nurture_step`, dedupe key `seq:<enrollmentOrAppt>:<step.id>`).
  - AI + `sms`/`email` → template if set, else AI-compose via setter agent in
    the lead's conversation; send through `sendSMSToLead`/`sendEmailToLead`
    (consent + allowlist + dry-run enforced there).
  - AI + `ai_call` → if `SEQUENCE_AI_CALLS_ENABLED=true` and `preCallCheck`
    passes → outbound Retell call; else human call task fallback.

## Executors rewired

- **Follow-up cron** (`/api/cron/follow-up-sequences`): loads the org's
  `new_lead_follow_up` DB steps (fallback: current hardcoded cadence). Keeps
  stop-on-reply, env gate, allowlist, advance-on-attempt, nurturing drop.
  Adds stop-on-booking (active appointment → stop).
- **Reminders cron** (`/api/cron/reminders`): if the org has an enabled
  `appointment_prep` sequence → generic step executor (dedupe via
  `appointment_reminders.reminder_type='seq:<step.id>'`, also stamps legacy
  `reminder_sent_72h/24h` flags); else legacy `sendAppointmentReminders`.
- **Auto-enroll**: after `triggerSpeedToLead` in `src/lib/leads/ingest.ts`,
  enroll the lead in `new_lead_follow_up` when the sequence is enabled.

## API

- `GET/POST /api/automation/sequences` — list with steps / create custom.
- `PATCH/DELETE /api/automation/sequences/[id]` — sequence flags; delete
  custom (non-system) only.
- `PUT /api/automation/sequences/[id]/steps` — bulk replace steps (zod).
  Toggling the `speed_to_lead` step's owner upserts the org-default
  `automation_policies` row (`kinds=['speed_to_lead']`); 409 if a broader
  org-default policy already governs it.
- Auth: `getOwnProfile` + `resolveActiveOrg` + `hasPermission`, same as
  `/api/autopilot/settings`.

## UI

`src/components/crm/workflow-sequences.tsx`, rendered under a new
Controls/Workflows tab toggle in `ai-control-center.tsx`. Each sequence is a
vertical timeline card: per-step offset editor (value + unit + before/after),
channel select, AI/Human segmented toggle, intent text, enabled switch,
add/remove step, sequence-level enabled + stop-condition switches, save = bulk
PUT. Badges show gate status: dry-run active, voice disabled, env flag off.

## Testing

Vitest unit tests for the pure scheduling/condition/dedupe-key logic; full
`npm run build` (type errors block Vercel).

## Out of scope (v1)

Arbitrary new triggers (stage_entered), per-step A/B copy, editing enrollment
mid-flight semantics (current_step indexes into the enabled-step list; edits
apply to future steps), Dion Desk routing.
