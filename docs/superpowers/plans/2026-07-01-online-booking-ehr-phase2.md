# Online Booking EHR — Phase 2 (Dion Clinical Bridge) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A self-contained, tested bridge that emits `appointment.requested/booked/cancelled` events to Dion Clinical's `/api/bus/receive`, validated against a vendored copy of Dion's contract, degrading cleanly when unconfigured. Not wired into the booking flow yet (that's Phase 3).

**Architecture:** Vendor a minimal, byte-faithful copy of Dion's envelope + appointment event schemas under `src/lib/bridges/dion/` (LI is islanded — no `@dion/*` import). `dion-clinical.ts` builds an envelope with `source: 'lead-intelligence'`, validates locally, and POSTs with the shared `x-forward-secret`. Mirrors the existing `growth-studio.ts` bridge (env-config, timeout, graceful failure — never throws).

**Tech Stack:** TypeScript, `zod` ^4.3.6, `fetch` + `AbortSignal.timeout`, Vitest.

**Spec:** §6.4. **Reference:** `~/dion-clinical/lib/dion/envelope.ts` + `lib/dion/events/appointment.ts` + `app/api/bus/receive/route.ts`.

---

## File Structure
- Create `src/lib/bridges/dion/envelope.ts` — envelope schema, `DION_PRODUCTS`, `dionEvent`, `newEnvelopeMeta`.
- Create `src/lib/bridges/dion/appointment.ts` — `appointment.*` zod schemas + union + `DionAppointmentEvent`.
- Create `src/lib/bridges/dion-clinical.ts` — `emitAppointmentRequested/Booked/Cancelled` + transport.
- Create `src/lib/__tests__/dion-clinical-bridge.test.ts` — tests.
- Modify `.env.local.example` + `src/lib/env.ts` — document `DION_CLINICAL_URL`, `DION_BUS_SECRET`.

---

## Task 1: Vendored envelope + appointment schemas

**Files:** Create `src/lib/bridges/dion/envelope.ts`, `src/lib/bridges/dion/appointment.ts`

- [ ] **Step 1: Write `envelope.ts`** — see final code in implementation. Faithful to Dion's `envelopeBase`/`dionEvent`/`newEnvelopeMeta`; `id`/`occurredAt` typed loosely (`z.string()`) since the sender generates valid uuid/ISO values and the receiver does the authoritative strict check.

- [ ] **Step 2: Write `appointment.ts`** — three `dionEvent(...)` schemas + `dionAppointmentSchema` discriminated union + `DionAppointmentEvent` type.

- [ ] **Step 3: tsc** — `npx tsc --noEmit` → PASS.

## Task 2: The bridge (`dion-clinical.ts`) — TDD

**Files:** Create `src/lib/bridges/dion-clinical.ts`, `src/lib/__tests__/dion-clinical-bridge.test.ts`

- [ ] **Step 1: Write the failing tests** (assert: POST to `${DION_CLINICAL_URL}/api/bus/receive`, `x-forward-secret` header, envelope `source:'lead-intelligence'`/`envelopeVersion:1`, correct `type` + `data` per event; unconfigured → `skipped`, no fetch; non-2xx → `ok:false`; local schema rejects malformed).
- [ ] **Step 2: Run → FAIL** (`@/lib/bridges/dion-clinical` missing).
- [ ] **Step 3: Implement the bridge** (env config, https/localhost guard, local `safeParse`, timeout, never throws).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Full `npx tsc --noEmit && npx vitest run`.**

## Task 3: Document env vars

**Files:** Modify `.env.local.example`, `src/lib/env.ts`
- [ ] Add `DION_CLINICAL_URL`, `DION_BUS_SECRET` to both. tsc + build unaffected.

## Task 4: Commit
- [ ] Commit the bridge + schemas + tests + env docs.

## Definition of Done
- `emitAppointment*` post the correct validated envelope to `/api/bus/receive`, degrade to `skipped` when unconfigured, never throw. Local schema mirrors Dion's contract. `tsc` clean + full suite green. Not yet wired into booking (Phase 3).
