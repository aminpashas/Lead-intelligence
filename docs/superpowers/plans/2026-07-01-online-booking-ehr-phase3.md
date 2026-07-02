# Online Booking EHR — Phase 3 (Sync Seam + Wiring + Slack + Retry) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** Make bookings actually reach the outside world: one fire-and-forget seam fires on every appointment create/cancel and drives the Dion Clinical event leg + a Slack notification; a retry cron re-drives failures. This is the first phase that changes request-path behavior.

**Architecture:** `syncAppointmentToEhr(supabase, appointmentId, {action})` loads the appointment/lead/org, emits `appointment.booked|cancelled` via the Phase-2 bridge (now with a **deterministic envelope id** so retries dedupe), and on `book` dispatches `consultation.scheduled` through the existing connector dispatcher (→ Slack). Per-leg status on the row; failures logged; never throws. Wired fire-and-forget into the public book route, the AI booking tool, and the appointments status endpoint. The CareStack write leg is deferred to Phase 4.

**Tech Stack:** TypeScript, Supabase, Vitest, `node:crypto` (deterministic uuid), existing `withCron` + `dispatchConnectorEvent`.

**Spec:** §6.5, §6.6, §6.8. Depends on Phases 1–2.

---

## File Structure
- Modify `src/lib/bridges/dion/envelope.ts` — `newEnvelopeMeta` accepts an `id` override.
- Modify `src/lib/bridges/dion-clinical.ts` — deterministic `stableUuid(appointmentId:type)` as the envelope id.
- Create `src/lib/booking/ehr-sync.ts` — the seam.
- Modify `src/app/api/booking/[orgId]/book/route.ts` — fire seam on confirmed booking.
- Modify `src/lib/autopilot/agent-tools.ts` — fire seam in `executeCreateBooking`.
- Modify `src/app/api/appointments/route.ts` — fire seam on `canceled`/`no_show`.
- Create `src/app/api/cron/ehr-appointment-sync/route.ts` + modify `vercel.json` — retry cron (Dion leg).
- Create `src/lib/__tests__/ehr-sync.test.ts`; extend `src/lib/__tests__/dion-clinical-bridge.test.ts`.

---

## Task 1: Deterministic envelope id (idempotent retries)
- [ ] `envelope.ts`: `newEnvelopeMeta(source, dionPracticeId, extras?: { id?; idempotencyKey?; traceId? })` → `id: extras?.id ?? crypto.randomUUID()`.
- [ ] `dion-clinical.ts`: add `stableUuid(seed)` (UUIDv5-style over SHA-1) and pass `id: stableUuid(idempotencyKey)` in all three emit helpers.
- [ ] Test (extend bridge test): two `emitAppointmentBooked` calls with the same `appointmentId` produce the **same** envelope `id`; different ids for different appts.
- [ ] `npx vitest run src/lib/__tests__/dion-clinical-bridge.test.ts` → PASS.

## Task 2: The seam (`src/lib/booking/ehr-sync.ts`) — TDD
- [ ] Write `src/lib/__tests__/ehr-sync.test.ts` (mock `@/lib/bridges/dion-clinical` + `@/lib/connectors`, hand-rolled chainable supabase stub). Assert: `book` → `emitAppointmentBooked` with `{appointmentId, startsAt, dionPracticeId}` + `dion_sync_status:'synced'` + `dispatchConnectorEvent('consultation.scheduled')`; `cancel` → `emitAppointmentCancelled` with `reasonCode`; emit failure → `dion_sync_status:'failed'` + a `lead_activities` failure row; missing appointment → no-op.
- [ ] Run → FAIL (seam missing).
- [ ] Implement `syncAppointmentToEhr(supabase, appointmentId, { action:'book'|'cancel', reasonCode? })`: load appt (`id, organization_id, lead_id, scheduled_at, ehr_sync_attempts`), load org `dion_practice_id`; Dion leg → set `dion_sync_status` (`synced`/`failed`/`skipped`) + `ehr_sync_error` + `ehr_sync_attempts+1`; on `book`, load lead + `dispatchConnectorEvent`; on failure log `ehr_sync_failed` activity; wrap everything so it never throws. (CareStack leg: comment marking Phase 4.)
- [ ] Run → PASS.

## Task 3: Wire the write-sites (fire-and-forget)
- [ ] `book/route.ts`: after the confirmed appointment insert (before the response), `void syncAppointmentToEhr(supabase, appointment.id, { action: 'book' })`.
- [ ] `agent-tools.ts` `executeCreateBooking`: after the appointment insert + lead update, `void syncAppointmentToEhr(supabase, appointment!.id, { action: 'book' })`.
- [ ] `appointments/route.ts` PATCH: after a successful update, if `status==='no_show'|'canceled'`, `void syncAppointmentToEhr(supabase, appointment_id, { action:'cancel', reasonCode: status==='no_show' ? 'no-show' : 'patient-cancel' })`.

## Task 4: Retry cron
- [ ] Create `src/app/api/cron/ehr-appointment-sync/route.ts` via `withCron('ehr-appointment-sync', ...)`: select appointments where `dion_sync_status in ('pending','failed')` and `ehr_sync_attempts < 5`, limit 50; for each, action = `(status in canceled/no_show) ? 'cancel' : 'book'`; call the seam. Return `{ processed }`.
- [ ] Add `{ "path": "/api/cron/ehr-appointment-sync", "schedule": "*/5 * * * *" }` to `vercel.json` crons.

## Task 5: Verify + commit
- [ ] `npx tsc --noEmit && npx vitest run` → clean + green.
- [ ] Commit.

## Definition of Done
- A confirmed booking (public/AI) emits `appointment.booked` to Dion + posts `consultation.scheduled` to Slack; a staff cancel/no-show emits `appointment.cancelled`. Deterministic envelope ids make retries idempotent. Retry cron re-drives failures. Everything fire-and-forget; a federation/Slack failure never blocks a booking. CareStack write remains Phase 4.

## Deferred (noted, not in Phase 3)
- `appointment.requested` for the phone-first call-request branch (no appointment row exists there; needs a non-slot-blocking model). CareStack write leg (Phase 4). Cal.com webhook + confirmation-call cancel sites (retry cron will not auto-catch these unless `dion_sync_status` is reset; wire in a follow-up). `booking_settings` seed + Slack webhook config are ops tasks (need org id + DB access).
