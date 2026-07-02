# Post-Consult Flow — Attendance Confirmation, Outcome Capture & Patient Feedback

**Date:** 2026-07-01
**Branch context:** builds directly on `feat/phone-first-booking` (commit `cd19d8c`), which added the `appointments` no-show-fee columns and `booking_settings` protocol config.
**Status:** Design approved (2026-07-01). Ready for implementation plan.

---

## 1. Problem & Goals

The phone-first booking work reduced *no-shows at booking time*, but the appointment lifecycle has no **after-the-appointment** loop. Three concrete gaps:

1. **No attendance confirmation.** Once an appointment's time passes, nothing prompts staff to record who showed up. The Appointments page even hides its action buttons for past appointments (`{!isPast && …}`), so consults silently rot in `scheduled`/`confirmed`. No-shows that should trigger the `$50` fee may never get marked.
2. **No structured outcome.** Only a free-text `notes` field exists. There is no record of *what happened* in the consult (accepted / considering / declined-why / quoted value), so there is no consult→close-rate signal.
3. **No patient feedback loop.** Nothing asks the patient how their visit went. The `pull-gbp-reviews` cron only ingests reviews that already exist on Google.

These are **one connected flow**, not three separate features:

```
appointment end-time passes
        │
        ▼
① ATTENDANCE PROMPT ──► staff: "Needs Outcome" queue + in-app bell + Slack
        │
   ┌────┴─────┐
   ▼          ▼
 Showed     No-Show ──► (existing) status=no_show → $50 auto-charge
   │
   ▼
② OUTCOME DIALOG ──► structured outcome + reason + quoted $ + notes + follow-up
        │            (advances lead status, logs to timeline)
        ▼
③ FEEDBACK REQUEST ──► SMS-first (email fallback), ~feedback_delay_hours after visit
        │             sent to EVERY patient who showed
   ┌────┴─────────┐
   ▼              ▼
 ≥ threshold★ →  < threshold★ →
 Google review   private capture → Slack service-recovery alert
 link            (never published)
```

### Success criteria
- Every past appointment reaches a terminal state (`completed` w/ outcome, `no_show`, `canceled`, `rescheduled`) — none silently stuck.
- Staff can record a structured outcome in ≤2 clicks from the Appointments page.
- Opted-in practices automatically request feedback from attendees; ≥`threshold`★ patients are routed to Google, `<threshold`★ are captured privately and flagged to staff.
- New consult-outcome and feedback analytics on the existing Analytics tab.
- Full test suite green + `tsc --noEmit` clean (tsc errors block the Vercel build).

### Non-goals (YAGNI)
- No new scheduling/calendar system — we annotate existing appointments.
- No multi-outcome-per-appointment (relationship is 1:1).
- No net-new notification table — reuse the existing realtime + Zustand + Slack stack.
- No editing of the Google review destination flow beyond storing the URL + redirecting to it.

---

## 2. Data Model

### 2.1 Extend `appointments` (columns, matching the phone-first precedent)

```sql
ALTER TABLE appointments
  -- Attendance-review queue
  ADD COLUMN IF NOT EXISTS outcome_review_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS outcome_prompt_sent_at timestamptz,
  -- Structured consult outcome (recorded when staff mark "Showed")
  ADD COLUMN IF NOT EXISTS consult_outcome text
    CHECK (consult_outcome IS NULL OR consult_outcome IN
      ('treatment_accepted','deposit_paid','considering','declined','referred_out','no_decision')),
  ADD COLUMN IF NOT EXISTS consult_outcome_reason text
    CHECK (consult_outcome_reason IS NULL OR consult_outcome_reason IN
      ('price','financing','timing','second_opinion','medical','spouse_partner','other')),
  ADD COLUMN IF NOT EXISTS quoted_value_cents integer CHECK (quoted_value_cents IS NULL OR quoted_value_cents >= 0),
  ADD COLUMN IF NOT EXISTS outcome_notes text,
  ADD COLUMN IF NOT EXISTS outcome_follow_up_at timestamptz,
  ADD COLUMN IF NOT EXISTS outcome_recorded_at timestamptz,
  ADD COLUMN IF NOT EXISTS outcome_recorded_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL;

-- Queue lookup: appointments awaiting an outcome decision.
CREATE INDEX IF NOT EXISTS idx_appointments_outcome_review_pending
  ON appointments (organization_id, outcome_review_pending)
  WHERE outcome_review_pending = true;

-- Feedback-dispatch lookup: showed + outcome recorded, awaiting/never sent a feedback request.
CREATE INDEX IF NOT EXISTS idx_appointments_outcome_recorded
  ON appointments (organization_id, outcome_recorded_at)
  WHERE outcome_recorded_at IS NOT NULL;
```

Rationale for columns (not a table): consistent with the just-shipped no-show-fee migration, avoids a join on every appointment read, and the relationship is strictly 1:1.

### 2.2 New table `patient_feedback`

A first-class entity with a request→response lifecycle and a public token.

```sql
CREATE TABLE IF NOT EXISTS patient_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,
  token text NOT NULL UNIQUE,                      -- public /feedback/[token]
  channel text NOT NULL CHECK (channel IN ('sms','email')),
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','responded','opted_out','bounced')),
  rating smallint CHECK (rating BETWEEN 1 AND 5),
  comment text,
  sentiment text CHECK (sentiment IS NULL OR sentiment IN ('positive','neutral','negative')),
  routed_to_review boolean NOT NULL DEFAULT false, -- did we send them to the public review link
  requested_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One outstanding request per appointment (idempotency for the cron).
CREATE UNIQUE INDEX IF NOT EXISTS uq_patient_feedback_appointment
  ON patient_feedback (appointment_id) WHERE appointment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_patient_feedback_org_status
  ON patient_feedback (organization_id, status);
```

RLS: standard org-scoped policy via `get_user_org_id()` (mirror the existing tables). The public `POST /api/feedback/[token]` route uses the **service client** and looks up strictly by unguessable `token` (no auth context), so RLS is not the guard there — the token is.

### 2.3 Extend `booking_settings` (where phone-first config lives)

```sql
ALTER TABLE booking_settings
  ADD COLUMN IF NOT EXISTS feedback_request_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS google_review_url text,
  ADD COLUMN IF NOT EXISTS feedback_promoter_threshold smallint NOT NULL DEFAULT 4
    CHECK (feedback_promoter_threshold BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS feedback_delay_hours integer NOT NULL DEFAULT 2
    CHECK (feedback_delay_hours BETWEEN 0 AND 168);
```

### 2.4 Types
Add the new columns/table/enums to `src/types/database.ts` (`Appointment`, new `PatientFeedback`, `BookingSettings`, and `ConsultOutcome` / `ConsultOutcomeReason` union types).

---

## 3. Lead-status mapping (outcome → pipeline)

When an outcome is recorded, advance `leads.status` (the fixed `LeadStatus` enum) the way the existing PATCH already updates status. `pipeline_stage` is a per-org custom table, so we do **not** touch it automatically.

| `consult_outcome`   | `leads.status`            |
|---------------------|---------------------------|
| `treatment_accepted`| `treatment_presented`     |
| `deposit_paid`      | `financing`               |
| `considering`       | `consultation_completed`  |
| `no_decision`       | `consultation_completed`  |
| `declined`          | `lost`                    |
| `referred_out`      | `disqualified`            |

`outcome_follow_up_at`, when set, is written so the existing follow-up/reengagement machinery can pick it up (no new scheduler).

---

## 4. Triggers & Server Logic

### 4.1 New cron `/api/cron/appointment-outcomes`
`CRON_SECRET`-protected, per-org loop (copy the `reminders` route shape). Suggested schedule: `*/30 * * * *`. Two passes per org:

**Pass A — attendance sweep.** Find appointments where
`scheduled_at + (duration_minutes||' minutes')::interval < now()`, `status IN ('scheduled','confirmed')`, and `outcome_prompt_sent_at IS NULL`. For each: set `outcome_review_pending = true`, `outcome_prompt_sent_at = now()`. Then, **once per org per run**, if any were newly flagged, post one batched Slack message ("3 consults need an outcome logged: …") via `slack/notify.ts`. (The in-app bell is driven by the realtime UPDATE, see §5.3 — not by the cron.)

**Pass B — feedback dispatch.** Only for orgs with `feedback_request_enabled = true` and a non-empty `google_review_url`. Find appointments where `status = 'completed'`, `outcome_recorded_at IS NOT NULL`, `now() > outcome_recorded_at + (feedback_delay_hours||' hours')::interval`, and **no `patient_feedback` row exists** for the appointment. For each (every attendee, regardless of outcome): create a `patient_feedback` row (`status='requested'`, random `token`, `channel` chosen below) and send the request:
- **SMS-first** via `sendSMSToLead()` (consent → compliance → quiet-hours → `us_sms_enabled` gates already pass for live orgs). Message links to `${NEXT_PUBLIC_APP_URL}/feedback/{token}` and carries STOP/opt-out.
- **Email fallback** via Resend when there is no phone / SMS is not sendable / send fails. Set `channel` to whichever actually went out.
- Never throws into the loop; a failed send marks the row `bounced` for retry visibility (mirrors the no-show-fee "never fail the flow" rule).

### 4.2 `POST /api/appointments/[id]/outcome`
Auth via `resolveActiveOrg` + BOLA check (appointment belongs to org). Body (Zod):
```ts
{ outcome: ConsultOutcome, reason?: ConsultOutcomeReason, quoted_value_cents?: number,
  notes?: string, follow_up_at?: string /* ISO */ }
```
Effects (single transaction-ish sequence):
1. Update appointment: `status='completed'`, the `consult_outcome*` columns, `outcome_recorded_at=now()`, `outcome_recorded_by=profile.id`, `outcome_review_pending=false`.
2. Update `leads.status` per §3; write `outcome_follow_up_at` if provided.
3. Insert a `lead_activities` row (`activity_type='consult_outcome_recorded'`, human title + outcome in metadata) so it shows on the Channel/timeline.
4. Return the updated appointment. (Feedback is dispatched by the cron, not here, to honor `feedback_delay_hours`.)

The existing **no-show** path stays on `PATCH /api/appointments` (already sets `no_show`, increments `no_show_count`, auto-charges the fee). Add one line there: clear `outcome_review_pending` on any terminal transition (`no_show`/`canceled`/`rescheduled`).

### 4.3 Public feedback endpoints
- `GET /feedback/[token]` — public page (service client), renders a 1–5★ tap UI. 404 on unknown/consumed token.
- `POST /api/feedback/[token]` — records `rating`, optional `comment`; sets `status='responded'`, `responded_at`, derives `sentiment` (≥4 positive / 3 neutral / ≤2 negative). Review-gating:
  - `rating >= feedback_promoter_threshold` → set `routed_to_review=true`, return `{ redirect: google_review_url }` for the client to send them to Google.
  - `rating < threshold` → keep private; insert a `lead_activities` row and post a Slack service-recovery alert ("⚠️ {name} rated their consult {rating}★: '{comment}'"). Never routed to Google.
  - Idempotent: a token already `responded`/`opted_out` returns a friendly "already received" state.

---

## 5. UI

### 5.1 Appointments page (`src/app/(dashboard)/appointments/page.tsx`)
- **New "Needs Outcome" tab** listing appointments with `outcome_review_pending = true` (past, undecided), newest first, with a count badge.
- **Fix the `!isPast` gate:** past appointments in this queue (and in Today) must show **Showed** and **No-Show** actions. `Showed` opens the Outcome dialog; `No-Show` calls the existing PATCH.
- Show a small "awaiting outcome" indicator on past cards elsewhere.

### 5.2 Outcome dialog (new component)
Fields: outcome `Select` (6 options) → conditional reason `Select` (shown only for `declined`) → `quoted_value_cents` money input → `outcome_notes` textarea → optional `outcome_follow_up_at` date. Submits to `POST /api/appointments/[id]/outcome`, then refetches. Reuses shadcn `Dialog`/`Select`/`Textarea`/`Input`.

### 5.3 In-app bell (`src/lib/hooks/use-realtime-notifications.ts`)
Extend the existing `notif-appointments` channel with an **UPDATE** listener: when `outcome_review_pending` flips `false→true`, `addNotification({ type:'appointment_needs_outcome', title:'Appointment needs an outcome', description:'{type} — did the patient show?', actionUrl:'/appointments' })` + a toast. No new table.

### 5.4 Settings → Booking protocol (`src/components/settings/booking-protocol-settings.tsx`)
Add a "Patient feedback" section: `feedback_request_enabled` Switch, `google_review_url` Input (required to enable — validate URL), `feedback_promoter_threshold` (1–5), `feedback_delay_hours`. Extend `ProtocolSettings` type + the `/api/settings/booking-protocol` GET/PATCH allow-list.

### 5.5 Analytics tab (`NoShowAnalyticsTab`)
Add two cards: **Consult Outcomes** (acceptance rate = accepted+deposit / attended; decline-reason breakdown; quoted-vs-recorded $) and **Feedback** (avg rating, response rate, count routed to Google, recent low-rating comments).

---

## 6. Consent, Compliance & Rollout

- **Attendance queue + Slack alerts: ON for everyone.** Purely internal; no patient-facing risk; no config required.
- **Patient feedback: opt-in per practice.** `feedback_request_enabled` defaults `false` and Pass B no-ops without a `google_review_url` — no patient is contacted until a practice deliberately configures it (mirrors the phone-first "default OFF, opt-in from Settings" precedent).
- Feedback sends reuse `sendSMSToLead` gates (consent, compliance filter, quiet hours, `us_sms_enabled`) and carry opt-out; email uses Resend. Existing STOP handling applies.
- Multi-tenant: every new row carries `organization_id`; new table gets org-scoped RLS. Cron uses the service client and loops orgs, like the others.

---

## 7. Testing

Follow existing patterns (`call-gate.test.ts`, `no-show-fee.test.ts`). Cover:
- Attendance sweep: flags only past, undecided appts; idempotent via `outcome_prompt_sent_at`.
- Outcome API: writes columns, maps lead status per §3, clears `outcome_review_pending`, logs activity; rejects bad enums (Zod).
- Feedback dispatch: only when enabled + URL set + past delay + no existing row; SMS-first / email-fallback channel selection; one row per appointment.
- Review-gating: `rating >= threshold` → `routed_to_review` + redirect; `< threshold` → private + Slack alert; token idempotency + unknown-token 404.
- `tsc --noEmit` clean; full suite green before any push (tsc errors fail the Vercel build).

---

## 8. Build order (for the implementation plan)
1. Migration + `database.ts` types.
2. Outcome API + no-show PATCH tweak (+ tests).
3. Appointments UI: Needs-Outcome tab, `!isPast` fix, Outcome dialog.
4. In-app bell UPDATE listener.
5. Cron `/api/cron/appointment-outcomes` (Pass A + B) + `vercel.json` entry (+ tests).
6. Public `/feedback/[token]` page + `POST /api/feedback/[token]` (+ tests) + Slack service-recovery.
7. Settings UI + booking-protocol allow-list.
8. Analytics cards.
9. Full suite + tsc; isolate in its own branch/worktree (shared-checkout hazard).
