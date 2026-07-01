# Online Booking EHR — Phase 1 (Migration + CareStack Client) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the schema + CareStack transport foundation for EHR-backed booking: add appointment-sync columns and CareStack booking-defaults, fix the CareStack client host, and add a typed CareStack scheduler API surface — all with no behavior change to the live booking flow yet.

**Architecture:** A SQL migration adds sync-tracking columns to `appointments`, CareStack defaults to `booking_settings`, and `dion_practice_id` to `organizations`; `database.ts` mirrors them. The existing generic `carestackFetch` transport gets its default host corrected to `pmsglobal.carestack.com`; a new `scheduler.ts` wraps `carestackFetch` in typed appointment/operatory/provider/patient calls that Phase 4 will build on. Nothing is wired into the request path in Phase 1.

**Tech Stack:** Next.js 16 / TypeScript, Supabase (Postgres) SQL migrations, Vitest (`npm test` → `vitest run`), existing CareStack OAuth client in `src/lib/ehr/carestack/`.

**Spec:** [`docs/superpowers/specs/2026-07-01-online-booking-ehr-integration-design.md`](../specs/2026-07-01-online-booking-ehr-integration-design.md) — Phase 1 covers spec §7 (data model) and §6.1 (client alignment).

**Reference (read-only, another repo):** `~/medicaldentalrcm/src/lib/carestack/client.ts` + `types.ts` — the proven CareStack API shapes.

---

## File Structure

- **Create** `supabase/migrations/20260701_ehr_appointment_sync.sql` — schema changes (Task 1).
- **Modify** `src/types/database.ts` — add fields to `Appointment` + `Organization`, add `EhrSyncStatus` (Task 2).
- **Modify** `src/lib/ehr/carestack/client.ts` — export a corrected default base-URL constant (Task 3).
- **Create** `src/lib/ehr/carestack/scheduler.ts` — typed CareStack scheduler API over `carestackFetch` (Task 4).
- **Create** `src/lib/__tests__/carestack-scheduler.test.ts` — Vitest unit tests for Tasks 3 & 4.

> Note: this refines spec §6.1 by putting the typed methods in a focused `scheduler.ts` rather than growing `client.ts` (transport). Phase 4's `appointments.ts` (business logic) will import `scheduler.ts`.

---

## Task 1: Schema migration

**Files:**
- Create: `supabase/migrations/20260701_ehr_appointment_sync.sql`

- [ ] **Step 1: Write the migration SQL**

Create `supabase/migrations/20260701_ehr_appointment_sync.sql`:

```sql
-- EHR appointment sync: track per-leg sync state on appointments, hold CareStack
-- booking defaults per org, and carry the Dion federation practice id.
-- Phase 1 of the CareStack + Dion Clinical online-booking integration (schema only;
-- no code reads these yet). All additive + idempotent.

-- 1. appointments: per-leg sync status + CareStack's id for the created appointment.
alter table public.appointments
  add column if not exists carestack_appointment_id text,
  add column if not exists carestack_sync_status text not null default 'pending'
    check (carestack_sync_status in ('pending','synced','failed','skipped')),
  add column if not exists dion_sync_status text not null default 'pending'
    check (dion_sync_status in ('pending','synced','failed','skipped')),
  add column if not exists ehr_sync_attempts integer not null default 0,
  add column if not exists ehr_sync_error text;

-- Partial index for the retry cron (rows with any leg still needing work).
create index if not exists idx_appointments_ehr_sync_pending
  on public.appointments (organization_id)
  where carestack_sync_status in ('pending','failed')
     or dion_sync_status in ('pending','failed');

-- 2. booking_settings: CareStack booking defaults (nullable; adapter falls back
--    to the first location/provider from the API when unset).
alter table public.booking_settings
  add column if not exists carestack_location_id text,
  add column if not exists carestack_provider_id text,
  add column if not exists carestack_operatory_id text,
  add column if not exists carestack_appointment_type text;

-- 3. organizations: Dion federation practice id (dionPracticeId on the bus envelope).
alter table public.organizations
  add column if not exists dion_practice_id text;
```

- [ ] **Step 2: Verify the SQL is well-formed**

Run: `grep -c "add column if not exists" supabase/migrations/20260701_ehr_appointment_sync.sql`
Expected: `10`

- [ ] **Step 3: Apply to the database (requires Supabase access)**

Run (linked project): `npx supabase db push`
OR apply the file via the Supabase SQL editor / psql.
Expected: success, no errors. (Additive `if not exists` — safe to re-run.)

Verify columns landed:
Run: `npx supabase db execute "select column_name from information_schema.columns where table_name='appointments' and column_name like '%sync%' or column_name='carestack_appointment_id' order by 1"`
Expected: `carestack_appointment_id`, `carestack_sync_status`, `dion_sync_status`, `ehr_sync_attempts` rows returned.

> If you have no DB access in this environment, note it and proceed — the migration is verified structurally (Step 2) and by the type-check in Task 2. It MUST be applied before Phase 3/4 features run.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260701_ehr_appointment_sync.sql
git commit -m "feat(booking): migration for EHR appointment-sync columns"
```

---

## Task 2: Mirror the schema in `database.ts`

**Files:**
- Modify: `src/types/database.ts` (`Appointment` type ~419-469; `Organization` type ~4-22)

- [ ] **Step 1: Add the `EhrSyncStatus` enum near the Appointment types**

In `src/types/database.ts`, immediately above `export type Appointment = {` (line ~419), add:

```typescript
export type EhrSyncStatus = 'pending' | 'synced' | 'failed' | 'skipped'
```

- [ ] **Step 2: Add the new fields to the `Appointment` type**

In `src/types/database.ts`, inside `export type Appointment = { ... }`, after the `no_show_fee_payment_intent_id: string | null` line (~460) and before `metadata: Record<string, unknown>` (~462), add:

```typescript

  // EHR sync (CareStack write-back + Dion Clinical event bus)
  carestack_appointment_id: string | null
  carestack_sync_status: EhrSyncStatus
  dion_sync_status: EhrSyncStatus
  ehr_sync_attempts: number
  ehr_sync_error: string | null
```

- [ ] **Step 3: Add `dion_practice_id` to the `Organization` type**

In `src/types/database.ts`, inside `export type Organization = { ... }`, after `feature_flags: Record<string, boolean>` (~14), add:

```typescript
  dion_practice_id: string | null
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS (exit 0), no new errors referencing `database.ts`. (Per project memory, `tsc` errors fail Vercel — keep it green.)

- [ ] **Step 5: Commit**

```bash
git add src/types/database.ts
git commit -m "feat(booking): database.ts types for EHR appointment-sync columns"
```

---

## Task 3: Correct the CareStack default host

**Files:**
- Modify: `src/lib/ehr/carestack/client.ts` (`getCareStackConfig`, ~76-77)
- Test: `src/lib/__tests__/carestack-scheduler.test.ts`

The proven CareStack host is `https://pmsglobal.carestack.com` (all `{domain}.carestack.com` subdomains route there), not `api.carestack.com`. We expose it as an exported constant so it's testable and reusable.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/carestack-scheduler.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { DEFAULT_CARESTACK_BASE_URL, DEFAULT_CARESTACK_IDENTITY_URL } from '@/lib/ehr/carestack/client'

describe('CareStack default hosts', () => {
  it('defaults the API host to pmsglobal.carestack.com', () => {
    expect(DEFAULT_CARESTACK_BASE_URL).toBe('https://pmsglobal.carestack.com')
  })

  it('defaults the identity host to id.carestack.com', () => {
    expect(DEFAULT_CARESTACK_IDENTITY_URL).toBe('https://id.carestack.com')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/carestack-scheduler.test.ts`
Expected: FAIL — `DEFAULT_CARESTACK_BASE_URL` is not exported / undefined.

- [ ] **Step 3: Add the exported constants and use them**

In `src/lib/ehr/carestack/client.ts`, add near the top after the imports (~line 22):

```typescript
export const DEFAULT_CARESTACK_BASE_URL = 'https://pmsglobal.carestack.com'
export const DEFAULT_CARESTACK_IDENTITY_URL = 'https://id.carestack.com'
```

Then in `getCareStackConfig`, replace the two default fallbacks (~76-77):

```typescript
    base_url: assertCareStackHost((settings.base_url || 'https://api.carestack.com').replace(/\/$/, '')),
    identity_url: assertCareStackHost((settings.identity_url || 'https://id.carestack.com').replace(/\/$/, '')),
```

with:

```typescript
    base_url: assertCareStackHost((settings.base_url || DEFAULT_CARESTACK_BASE_URL).replace(/\/$/, '')),
    identity_url: assertCareStackHost((settings.identity_url || DEFAULT_CARESTACK_IDENTITY_URL).replace(/\/$/, '')),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/carestack-scheduler.test.ts`
Expected: PASS (both host tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ehr/carestack/client.ts src/lib/__tests__/carestack-scheduler.test.ts
git commit -m "fix(carestack): default API host to pmsglobal.carestack.com"
```

---

## Task 4: Typed CareStack scheduler API (`scheduler.ts`)

**Files:**
- Create: `src/lib/ehr/carestack/scheduler.ts`
- Test: `src/lib/__tests__/carestack-scheduler.test.ts` (append)

Thin, typed wrappers over the existing `carestackFetch` transport. These issue the exact endpoints proven in MDRCM. No business logic (patient matching, LI→CareStack mapping, persistence) — that's Phase 4.

- [ ] **Step 1: Write the failing tests (append to the test file)**

Append to `src/lib/__tests__/carestack-scheduler.test.ts`:

```typescript
import { afterEach, vi } from 'vitest'
import type { CareStackConfig } from '@/lib/ehr/carestack/client'
import {
  createCsAppointment,
  cancelCsAppointment,
  getCsOperatories,
  getCsProviders,
  getCsLocations,
  searchCsPatients,
  createCsPatient,
  getCsSyncAppointments,
} from '@/lib/ehr/carestack/scheduler'

const cfg: CareStackConfig = {
  account_id: 'acct',
  client_id: 'cid',
  client_secret: 'sec',
  username: 'vendor',
  password: 'accountkey',
  base_url: 'https://pmsglobal.carestack.com',
  identity_url: 'https://id.carestack.com',
}

// Records every fetch call. Token requests get a fake bearer; API requests get `payload`.
function installFetchMock(payload: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push({ url, init })
    if (url.includes('/connect/token')) {
      return new Response(JSON.stringify({ access_token: 't0ken', expires_in: 3600 }), { status: 200 })
    }
    return new Response(JSON.stringify(payload), { status: 200 })
  })
  vi.stubGlobal('fetch', mock)
  return { calls, api: () => calls.find((c) => !c.url.includes('/connect/token'))! }
}

describe('CareStack scheduler API', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('createCsAppointment POSTs /api/v1.0/appointments with the body', async () => {
    const { api } = installFetchMock({ appointmentId: 999 })
    const body = { patientId: '5', locationId: '1', providerId: '2', scheduledStart: '2026-07-10T15:00:00Z', scheduledEnd: '2026-07-10T16:00:00Z', duration: 60, appointmentType: 'consultation', status: 'scheduled', isNewPatient: true }
    const res = await createCsAppointment(cfg, body)
    const call = api()
    expect(call.url).toBe('https://pmsglobal.carestack.com/api/v1.0/appointments')
    expect(call.init?.method).toBe('POST')
    expect(JSON.parse(call.init!.body as string)).toMatchObject({ patientId: '5', duration: 60 })
    expect((res as { appointmentId: number }).appointmentId).toBe(999)
  })

  it('cancelCsAppointment PUTs /api/v1.0/appointments/{id}/cancel', async () => {
    const { api } = installFetchMock({ appointmentId: 999, status: 'cancelled' })
    await cancelCsAppointment(cfg, '999')
    const call = api()
    expect(call.url).toBe('https://pmsglobal.carestack.com/api/v1.0/appointments/999/cancel')
    expect(call.init?.method).toBe('PUT')
  })

  it('getCsOperatories GETs /api/v1.0/operatories', async () => {
    const { api } = installFetchMock([{ id: 1, locationId: 1, name: 'Op 1' }])
    const ops = await getCsOperatories(cfg)
    expect(api().url).toBe('https://pmsglobal.carestack.com/api/v1.0/operatories')
    expect(ops[0].name).toBe('Op 1')
  })

  it('getCsProviders GETs /api/v1.0/providers', async () => {
    const { api } = installFetchMock([{ id: 2, firstName: 'A', lastName: 'B' }])
    await getCsProviders(cfg)
    expect(api().url).toBe('https://pmsglobal.carestack.com/api/v1.0/providers')
  })

  it('getCsLocations GETs /api/v1.0/locations', async () => {
    const { api } = installFetchMock([{ id: 1, name: 'Main' }])
    await getCsLocations(cfg)
    expect(api().url).toBe('https://pmsglobal.carestack.com/api/v1.0/locations')
  })

  it('searchCsPatients POSTs /api/v2.0/patients/search', async () => {
    const { api } = installFetchMock([])
    await searchCsPatients(cfg, { email: 'x@y.com' })
    const call = api()
    expect(call.url).toBe('https://pmsglobal.carestack.com/api/v2.0/patients/search')
    expect(call.init?.method).toBe('POST')
    expect(JSON.parse(call.init!.body as string)).toEqual({ email: 'x@y.com' })
  })

  it('createCsPatient POSTs /api/v1.0/patients', async () => {
    const { api } = installFetchMock({ id: 5 })
    await createCsPatient(cfg, { firstName: 'A', lastName: 'B' })
    const call = api()
    expect(call.url).toBe('https://pmsglobal.carestack.com/api/v1.0/patients')
    expect(call.init?.method).toBe('POST')
  })

  it('getCsSyncAppointments GETs /sync/appointments with modifiedSince', async () => {
    const { api } = installFetchMock({ results: [], continueToken: null })
    await getCsSyncAppointments(cfg, '2026-07-01T00:00:00Z')
    const call = api()
    expect(call.url).toContain('https://pmsglobal.carestack.com/api/v1.0/sync/appointments')
    expect(call.url).toContain('modifiedSince=2026-07-01T00%3A00%3A00Z')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/carestack-scheduler.test.ts`
Expected: FAIL — `@/lib/ehr/carestack/scheduler` module / its exports don't exist.

- [ ] **Step 3: Implement `scheduler.ts`**

Create `src/lib/ehr/carestack/scheduler.ts`:

```typescript
/**
 * Typed CareStack scheduler API — thin wrappers over the generic carestackFetch
 * transport. Endpoints proven in the sibling MDRCM client (v1.0.54). No business
 * logic here (patient matching / LI→CareStack mapping / persistence live in the
 * Phase 4 appointments adapter). Ids are treated as strings (never arithmetic).
 */
import { carestackFetch, type CareStackConfig } from './client'

// ── Types (minimal mirror of CareStack shapes we use) ───────────────────────
export type CsAppointmentStatus =
  | 'scheduled' | 'confirmed' | 'arrived' | 'in_chair'
  | 'completed' | 'cancelled' | 'no_show' | 'rescheduled'

export interface CsAppointment {
  appointmentId: string | number
  patientId: string
  locationId: string
  providerId: string
  operatoryId?: string
  scheduledStart: string
  scheduledEnd: string
  duration: number
  appointmentType: string
  cdtCodes?: string[]
  status: CsAppointmentStatus
  notes?: string
  isNewPatient: boolean
}

export interface CsOperatory { id: number; locationId: number; name: string }
export interface CsProvider { id: number; firstName?: string; lastName?: string; fullName?: string }
export interface CsLocation { id: number; name: string; timeZone?: string }
export interface CsPatient { id: number; firstName?: string; lastName?: string; email?: string; mobileNumber?: string }
export interface CsSyncAppointmentsResponse {
  results?: Array<Record<string, unknown>>
  continueToken?: string | null
}

// ── Appointments ────────────────────────────────────────────────────────────
export function getCsAppointment(config: CareStackConfig, appointmentId: string) {
  return carestackFetch<CsAppointment>(config, `/appointments/${appointmentId}`)
}

export function createCsAppointment(config: CareStackConfig, appointment: Partial<CsAppointment>) {
  return carestackFetch<CsAppointment>(config, '/appointments', { method: 'POST', body: appointment })
}

export function cancelCsAppointment(config: CareStackConfig, appointmentId: string) {
  return carestackFetch<CsAppointment>(config, `/appointments/${appointmentId}/cancel`, { method: 'PUT' })
}

// ── Schedule reference data ──────────────────────────────────────────────────
export function getCsOperatories(config: CareStackConfig) {
  return carestackFetch<CsOperatory[]>(config, '/operatories')
}

export function getCsProviders(config: CareStackConfig) {
  return carestackFetch<CsProvider[]>(config, '/providers')
}

export function getCsLocations(config: CareStackConfig) {
  return carestackFetch<CsLocation[]>(config, '/locations')
}

// ── Patients ──────────────────────────────────────────────────────────────── 
export function searchCsPatients(config: CareStackConfig, searchParams: Record<string, unknown>) {
  // Patient search is on v2.0.
  return carestackFetch<CsPatient[]>(config, '/patients/search', { method: 'POST', body: searchParams, version: 'v2.0' })
}

export function createCsPatient(config: CareStackConfig, patient: Partial<CsPatient>) {
  return carestackFetch<CsPatient>(config, '/patients', { method: 'POST', body: patient })
}

// ── Sync (availability overlay input, Phase 5) ───────────────────────────────
export function getCsSyncAppointments(config: CareStackConfig, modifiedSince: string, continueToken?: string) {
  return carestackFetch<CsSyncAppointmentsResponse>(config, '/sync/appointments', {
    query: { modifiedSince, continueToken: continueToken ?? undefined },
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/carestack-scheduler.test.ts`
Expected: PASS — all scheduler + host tests green.

- [ ] **Step 5: Full type-check + test suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: `tsc` clean; full suite passes (no regressions).

- [ ] **Step 6: Commit**

```bash
git add src/lib/ehr/carestack/scheduler.ts src/lib/__tests__/carestack-scheduler.test.ts
git commit -m "feat(carestack): typed scheduler API (appointments/operatories/providers/patients)"
```

---

## Phase 1 Definition of Done

- Migration `20260701_ehr_appointment_sync.sql` exists, is additive/idempotent, and (where DB access exists) applied.
- `database.ts` mirrors the new columns; `npx tsc --noEmit` is clean.
- CareStack client defaults to `pmsglobal.carestack.com` via an exported constant.
- `scheduler.ts` exposes typed create/cancel/get appointment + operatories/providers/locations + patient search/create + sync-appointments, each unit-tested against the exact endpoint/method/body with a mocked `fetch`.
- `npx vitest run` passes. No request-path behavior changed (foundation only).

## Self-Review (completed by planner)

- **Spec coverage:** §7 data model → Tasks 1–2 (note: corrected — `appointments` gets a new `carestack_appointment_id text`; `ehr_appointment_id` was on `treatment_procedures`). §6.1 client alignment → Tasks 3–4 (host default + typed methods; the account-id header was already absent, so no auth-header change needed). Availability read (§6.3), the seam (§6.5), Slack (§6.8), Dion bridge (§6.4), CareStack write logic (§6.2) are later phases — out of Phase 1 scope by design.
- **Placeholder scan:** none — all SQL, TS, and test code is complete.
- **Type consistency:** `CareStackConfig` imported from `client.ts` (existing export). `EhrSyncStatus` defined in Task 2 and used only there. Scheduler fn names (`createCsAppointment`, `cancelCsAppointment`, `getCsOperatories`, `getCsProviders`, `getCsLocations`, `searchCsPatients`, `createCsPatient`, `getCsSyncAppointments`) match between tests (Task 4 Step 1) and implementation (Task 4 Step 3). `carestackFetch` signature `(config, path, opts?)` matches `client.ts`.
