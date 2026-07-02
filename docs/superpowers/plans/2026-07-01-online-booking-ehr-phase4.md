# Online Booking EHR — Phase 4 (CareStack Write Leg) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** Complete the write path: a confirmed booking creates a real CareStack appointment (find-or-create the patient first) and a cancel/no-show cancels it — added as the third leg of the existing seam, behind `getCareStackConfig` so it's a no-op until creds are seeded.

**Architecture:** New `src/lib/ehr/carestack/appointments.ts` adapter (find-or-create patient via `scheduler.ts` + `upsertCareStackPatient`; map an LI appointment → `CsAppointment` using `booking_settings` defaults with API fallbacks; cancel). The seam gains a CareStack leg that records `carestack_sync_status` + `carestack_appointment_id`; the retry cron re-drives it too. All unit-tested with mocked scheduler/adapter.

**Tech Stack:** TypeScript, Supabase, Vitest, Phase-1 `scheduler.ts`, existing `match.ts` (`upsertCareStackPatient`), `@/lib/encryption`.

**Spec:** §6.2. Depends on Phases 1–3.

---

## File Structure
- Create `src/lib/ehr/carestack/appointments.ts` — `ensureCareStackPatient`, `pushAppointmentToCareStack`, `cancelAppointmentInCareStack`.
- Modify `src/lib/booking/ehr-sync.ts` — add CareStack leg; combined single row update; load lead on book only.
- Modify `src/app/api/cron/ehr-appointment-sync/route.ts` — include `carestack_sync_status` in the retry filter.
- Create `src/lib/__tests__/carestack-appointments.test.ts`.
- Modify `src/lib/__tests__/ehr-sync.test.ts` — mock `getCareStackConfig` + adapter; add CareStack-leg cases.

---

## Task 1: CareStack appointment adapter — TDD
- [ ] Tests (`carestack-appointments.test.ts`, mock `./scheduler` + `./match`, stub supabase): existing lead→patient mapping short-circuits (no search/create); email-search hit reuses id (no create); miss → `createCsPatient` (isNew true); `pushAppointmentToCareStack` builds `{patientId, locationId, providerId, scheduledStart/End (=start+duration), duration, status:'scheduled', isNewPatient}` and returns the created id; location/provider fall back to first from API when settings unset; `cancelAppointmentInCareStack` calls `cancelCsAppointment`.
- [ ] Run → FAIL.
- [ ] Implement `appointments.ts`.
- [ ] Run → PASS.

## Task 2: Wire the CareStack leg into the seam
- [ ] `ehr-sync.ts`: select `duration_minutes, carestack_appointment_id`; load lead only on `book`; run CareStack leg via `getCareStackConfig` (null → `skipped`); on `book` → `pushAppointmentToCareStack` (loads `booking_settings` defaults) → set `carestack_appointment_id`; on `cancel` → `cancelAppointmentInCareStack` when an id exists; combine both legs into ONE appointments update (`dion_sync_status`, `carestack_sync_status`, `carestack_appointment_id?`, `ehr_sync_attempts+1`, `ehr_sync_error`); log a failure activity per failed leg; never throw.
- [ ] Extend `ehr-sync.test.ts`: mock `@/lib/ehr/carestack/client` (`getCareStackConfig` default null) + `@/lib/ehr/carestack/appointments`; assert config-present book → `pushAppointmentToCareStack` called + `carestack_sync_status:'synced'` + `carestack_appointment_id` stored; cancel-with-id → `cancelAppointmentInCareStack` called; existing Phase-3 cases still pass (CareStack `skipped`).

## Task 3: Retry cron covers CareStack
- [ ] `ehr-appointment-sync/route.ts`: change the filter to re-drive rows where **either** `dion_sync_status` **or** `carestack_sync_status` is `pending`/`failed` (use `.or(...)`), `ehr_sync_attempts < 5`.

## Task 4: Verify + commit
- [ ] `npx tsc --noEmit && npx vitest run` → clean + green. Commit.

## Definition of Done
- Confirmed bookings create a CareStack appointment (patient auto-resolved) and store its id; cancels/no-shows cancel it; retry cron covers both legs; entirely gated by `getCareStackConfig` (skips cleanly until creds seeded). All three legs (CareStack, Dion, Slack) now live in code.

## Notes / live-tuning follow-ups (behind the config gate)
- CareStack v2.0 patient-search param names (`{ email }`) + `scheduledStart` timezone semantics are best-effort; verify against the live API when creds land. `CsAppointment.appointmentId` stored as text.
