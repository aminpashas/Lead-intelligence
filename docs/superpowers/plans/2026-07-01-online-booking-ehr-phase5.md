# Online Booking EHR — Phase 5 (CareStack Availability Overlay) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** Two-way read — the AI/widget stop offering chairs that are actually taken in CareStack. Pull CareStack appointment occupancy into a dedicated `ehr_busy_slots` table and feed it into the existing availability engine.

**Architecture:** A sync (`syncCareStackBusySlots`, run from the carestack-sync cron) drains `GET /sync/appointments` and upserts occupancy into `ehr_busy_slots`. A read helper (`fetchEhrBusyAsAppointments`) returns those blocks shaped as `ExistingAppointment`, which each availability call-site merges into the array it already passes to `generateAvailableSlots` — the engine is unchanged. Empty table → zero effect, so it's safe before any sync runs.

**Tech Stack:** TypeScript, Supabase, Vitest, Phase-1 `scheduler.ts` (`getCsSyncAppointments`), existing `generateAvailableSlots`, `withCron`.

**Spec:** §6.3. Depends on Phases 1–4. Decision: dedicated `ehr_busy_slots` table (appointments.lead_id is NOT NULL, so external occupancy doesn't fit there).

---

## File Structure
- Create `supabase/migrations/20260701_ehr_busy_slots.sql` — the table.
- Modify `src/types/database.ts` — `EhrBusySlot` type.
- Create `src/lib/ehr/carestack/busy-sync.ts` — `syncCareStackBusySlots`.
- Create `src/lib/booking/ehr-busy.ts` — `fetchEhrBusyAsAppointments`.
- Modify `src/app/api/cron/carestack-sync/route.ts` — add the busy-slots runner.
- Modify the 4 availability call-sites (slots route, book route, agent-tools `executeGetAvailableSlots` + `executeCreateBooking`) — merge busy slots.
- Create `src/lib/__tests__/ehr-busy.test.ts`.

---

## Task 1: Migration
- [ ] `20260701_ehr_busy_slots.sql`: table `ehr_busy_slots(id uuid pk, organization_id uuid fk, ehr_source text default 'carestack', ehr_appointment_id text not null, ehr_patient_id text, starts_at timestamptz not null, ends_at timestamptz not null, status text, appointment_type text, created_at, updated_at)`; unique `(organization_id, ehr_source, ehr_appointment_id)`; index `(organization_id, starts_at)`.
- [ ] Verify + note apply.

## Task 2: `database.ts`
- [ ] Add `EhrBusySlot` type.

## Task 3: Read helper — TDD
- [ ] `ehr-busy.test.ts`: `fetchEhrBusyAsAppointments` returns active blocks as `{scheduled_at, duration_minutes, status:'scheduled'}`; excludes cancelled/no_show; duration = round((ends-starts)/60000).
- [ ] Implement `src/lib/booking/ehr-busy.ts`.

## Task 4: Sync
- [ ] `busy-sync.ts` `syncCareStackBusySlots(supabase, orgId, config)`: drain `getCsSyncAppointments(modifiedSince=now-30d)` with continueToken (page cap 50); map `a.id→ehr_appointment_id`, `a.startDateTime→starts_at`, `starts_at + (a.duration ?? 60)min → ends_at`, `statusMap(a.status)`, `a.patientId`, `a.productionTypeId→appointment_type`; skip rows with no valid start; upsert onConflict `organization_id,ehr_source,ehr_appointment_id`. Returns the cron run shape.
- [ ] Wire into carestack-sync cron as a 4th runner.

## Task 5: Merge into the 4 availability sites
- [ ] Each: after loading db appts, `const ehrBusy = await fetchEhrBusyAsAppointments(supabase, orgId, settings.advance_days)`, pass `[...(dbAppts||[]), ...ehrBusy]` to `generateAvailableSlots`.

## Task 6: Verify + commit
- [ ] `npx tsc --noEmit && npx vitest run` clean + green. Commit.

## Definition of Done
- CareStack occupancy is synced to `ehr_busy_slots` and subtracted from offered slots everywhere availability is computed; engine untouched; zero effect until sync runs. Two-way CareStack integration complete.

## Live-tuning follow-ups (behind creds)
- `/sync/appointments` field names (`startDateTime`/`duration`/`productionTypeId`) per MDRCM; verify live. `modifiedSince` uses a 30-day lookback — a proper per-org incremental cursor is a follow-up.
