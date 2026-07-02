# No-Show Prevention & Appointment Stage Automation — Design

**Date:** 2026-07-02
**Status:** Approved
**Branch target:** new isolated branch off `main` (per-session worktree)

## Problem

1. Booking a consult sets `lead.status = 'consultation_scheduled'` but never moves the
   pipeline `stage_id`, so the kanban board doesn't reflect bookings. Staff drag cards
   manually or approve copilot suggestions.
2. The reminder engine (72h email → 24h SMS+email → 2h AI call → 1h SMS) treats
   confirmation as terminal: risk is hard-set to 5 and all escalation stops. Patients
   who confirm still no-show, and nothing catches them. `calculateNoShowRisk` exists
   but nothing calls it.
3. There is no escalation to humans and no post-no-show recovery flow.

## Decisions (user-approved)

- **Escalation:** tiered — AI first (medium risk), humans for the worst cases (high risk).
- **Stage moves:** full lifecycle automation — booked, canceled, and no-show all auto-move
  the card. No approval step.
- **Recovery:** included — same-day "we missed you" SMS plus a short rebook nurture.

## Approach

Extend the live engine (Approach A). No new subsystem: a shared stage-mover helper,
a new escalation pass inside the existing 15-minute reminders cron, and a `no_show`
trigger event on the existing trigger-campaign infrastructure. One small migration.

## 1. Stage automation — `src/lib/pipeline/stage-mover.ts`

One exported function:

```
moveLeadStageForAppointmentEvent(supabase, {
  orgId, leadId, event: 'booked' | 'canceled' | 'no_show'
}): Promise<{ moved: boolean; stageId?: string; reason?: string }>
```

- Loads the org's `pipeline_stages`; matches by regex like `suggest-stage.ts`:
  - `booked` → first stage matching `/consult|schedul|book|appoint/i`
  - `canceled` / `no_show` → first stage matching `/no.?show|re.?engage|nurtur/i`
- Guards (same as suggest-stage): never move a lead already in a won/lost stage;
  no-op if no matching stage exists or the lead is already there.
- Writes a `lead_activities` row (`activity_type: 'stage_auto_moved'`) with
  from/to stage and the triggering event.
- Non-fatal: failures are logged and never block the calling flow.

**Call sites** (all fire-and-forget after their primary write succeeds):
- `POST /api/appointments` (staff booking) — `booked`
- `PATCH /api/appointments` — `canceled` on cancel, `no_show` on no-show
- `POST /api/booking/[orgId]/book` (public widget) — `booked`
- AI booking tool used by voice/SMS agents — `booked`
- Cal.com webhook (`/api/webhooks/cal`) — `booked` / `canceled`
- CareStack webhook appointment handler — `booked` / `canceled` / `no_show`
  as its event types map

No schema change.

## 2. Risk that survives confirmation

Rebalance `calculateNoShowRisk` in `src/lib/campaigns/reminders.ts`:

- Confirmation is a strong *downward* signal, not a terminal state:
  `confirmed → base 5`, then history still adds:
  - prior no-shows: `+ min(no_show_count * 20, 40)`
  - engagement_score < 20: `+ 10`
  - stale check-in (tier-1 check-in sent, no reply): `+ 25`
- Unconfirmed base stays 30 with the existing additions.
- Remove the two places that hard-set `no_show_risk_score = 5` on confirmation
  (`confirmAppointment`, appointments PATCH); both now call `calculateNoShowRisk`.
- The reminders cron recomputes risk for every `scheduled`/`confirmed` appointment
  within the next 48h on each run, so day-of risk is always fresh.

## 3. Tiered escalation ladder

New pass in `sendAppointmentReminders` (new module
`src/lib/campaigns/attendance-escalation.ts`, invoked from the orchestrator),
running for appointments **on the day of** the visit:

- **Tier 1 — medium risk (40–69), morning-of (~4h before, window-based like the
  other reminders):** AI check-in SMS that requires a reply
  ("Reply YES if we'll see you at {time}"). Stamped `checkin_sent_at`.
  - Reply YES (Twilio inbound webhook, same matcher that handles confirmations) →
    `checkin_replied_at`, risk recomputed downward.
  - No reply within 2 hours → the appointment is treated as *unconfirmed again*:
    `confirmation_received` no longer suppresses the 2h AI confirmation call for
    it (implemented as: 2h call query includes confirmed appointments whose
    check-in expired unanswered).
- **Tier 2 — high risk (≥70), day-of:** create one staff task (existing task/queue
  mechanism used by the attendance-confirm queue) and one Slack alert through the
  existing connector dispatcher, with lead context (name, phone, prior no-show
  count, last touch, appointment time). Stamped `escalation_tier = 2`,
  `escalated_at`. Never repeated for the same appointment.
- Thresholds are constants for now (`RISK_TIER1 = 40`, `RISK_TIER2 = 70`);
  future per-practice tuning goes into `booking_settings`.
- All sends go through `sendSMSToLead` / `preCallCheck` — consent, quiet hours,
  `us_sms_enabled`, and autopilot gating apply unchanged. Every touch is logged
  to `appointment_reminders` (`reminder_type: 'checkin_4h'` / `'escalation'`).

**Migration** (`appointments` table): `escalation_tier smallint`,
`escalated_at timestamptz`, `checkin_sent_at timestamptz`,
`checkin_replied_at timestamptz`.

## 4. No-show recovery

On no-show (staff PATCH and CareStack webhook path):

- Stage auto-move (§1) to the re-engage stage.
- Fire `processTriggerCampaigns` with a new `no_show` event.
- New lazily-seeded per-org campaign `seedNoShowRecovery` (mirrors
  `seedPostConsultNurture`): immediate same-day "we missed you — want to grab
  another time?" SMS with rebook link, then 2 more touches (~day 3, ~day 10).
  Autopilot- and consent-gated like all campaign sends.
- Booking a new appointment for the lead unenrolls them from the recovery
  campaign (same cancel-on-trigger mechanism the existing nurtures use).

## 5. Surfacing

Appointments dashboard (`/appointments`): show `no_show_risk_score` and
escalation state per row; add an "At-risk today" filter (day-of appointments
with risk ≥ 40). Activation of the existing page, no new routes beyond the
data already returned by `GET /api/appointments`.

## 6. Testing

Unit tests (Vitest, existing patterns in `src/lib/__tests__/`):
- stage-mover: regex matching, won/lost guard, no-matching-stage no-op,
  already-in-stage no-op.
- risk rebalance: confirmed + prior no-shows lands mid-band; check-in decay.
- ladder: tier selection at boundaries (39/40/69/70), tier-2 fires once,
  check-in expiry re-arms the 2h call query.
- recovery: `no_show` trigger enrolls; new booking unenrolls.

`tsc --noEmit` must be green (Vercel build blocks on type errors).

## Out of scope

- Per-practice threshold configuration UI.
- Changes to the Stripe no-show fee flow (already live).
- EHR write-backs beyond what `syncAppointmentToEhr` already does.
