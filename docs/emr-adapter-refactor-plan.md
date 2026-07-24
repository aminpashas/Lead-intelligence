# EhrAdapter refactor plan — making the second EMR cheap

## Context

Competitors advertise "integrates with 40+ EMRs". The research in
[`emr-integration-landscape.md`](./emr-integration-landscape.md) concluded that **no vendor
sells that capability** — the market splits into three segments with disjoint middleware, and
aesthetics (PatientNow, Nextech, Symplast) has no aggregator at all. Every EMR beyond our first
is either a direct adapter we build or a single aggregator-backed adapter covering a cluster.

So the lever is not procurement, it's architecture: **make the marginal cost of adding an EMR
small.** Today it is not. We have ~2,800 lines of working CareStack integration under
`src/lib/ehr/carestack/`, and adding a second EMR means editing the booking seam, the cron
route, six table schemas, and the outcome rollup.

The goal of this refactor is a vendor-neutral **port** in Lead Intelligence with CareStack as
adapter #1 — so EMR #2 is a new directory plus a registry entry, and nothing else moves.

**Out of scope:** actually building a second adapter, and any vendor contract. This is the seam
only.

### Portfolio constraint

[`ECOSYSTEM.md`](../ECOSYSTEM.md) assigns *Legacy PMS import* to a shared `@dion/pms-connectors`
package and *Clinical chart / EMR* to Dion Clinical. That package **does not exist yet** (absent
from `package.json` and `node_modules/`). This plan therefore:

- keeps the **port** in LI (consumer side — booking, availability, lead-outcome attribution, all
  squarely "Sales / lead CRM" which LI owns);
- shapes each **adapter** as a self-contained directory depending only on the port types, so it
  can be lifted into `@dion/pms-connectors` later without dragging LI's schema along;
- does **not** expand what clinical data we retain — EHR reads exist to answer *did this lead
  book, show, and accept treatment*, nothing more.

---

## Current state

**Already vendor-neutral — do not touch.** Every EHR table carries an `ehr_source`
discriminator that is part of its unique key, and `EhrSource` is already typed for future
systems (`src/types/database.ts:1953`):

```ts
export type EhrSource = 'carestack' | 'open_dental' | 'dentrix' | 'eaglesoft' | 'manual'
```

`patients`, `ehr_appointments`, `ehr_busy_slots`, `treatment_plans`, `treatment_procedures`,
`invoices`, `ehr_sync_state` all key on `(organization_id, ehr_source, …)`. Whoever designed
this anticipated multi-EMR. Roughly 70% of the work is already done.

**The consumer side is also clean.** `src/lib/booking/ehr-busy.ts` reads `ehr_busy_slots` with
no vendor knowledge at all — it works unchanged for any adapter that writes that table.

### What is actually coupled

| # | Coupling | Location |
|---|---|---|
| 1 | Booking seam imports CareStack directly | `src/lib/booking/ehr-sync.ts:20-21`, `runCareStackLeg` at `:50` |
| 2 | Cron hardcodes the six CareStack runners | `src/app/api/cron/carestack-sync/route.ts:30-34` |
| 3 | Vendor-named columns | `appointments.carestack_appointment_id` / `.carestack_sync_status`; `booking_settings.carestack_{location,provider,operatory}_id`, `.carestack_appointment_type` (`supabase/migrations/20260701_ehr_appointment_sync.sql`) |
| 4 | **Numeric ID columns** | `ehr_appointments.ehr_appointment_id` is `bigint`; `treatment_procedures.ehr_procedure_id`, `invoices.ehr_invoice_id`, `treatment_plans.ehr_treatment_plan_id` are `number` |
| 5 | CareStack status enums in shared logic | `rollup.ts:28-29` (`PROC_STATUS_ACCEPTED = 3`, `PROC_STATUS_COMPLETED = 8`), consult-status strings at `:277` |
| 6 | Per-vendor webhook route | `src/app/api/webhooks/carestack/route.ts` |

**#4 is the blocking one.** CareStack uses numeric IDs; most other EMRs use GUIDs or opaque
strings. A GUID cannot be stored in a `bigint`. Note the existing inconsistency —
`ehr_busy_slots.ehr_appointment_id` is already `text` while `ehr_appointments.ehr_appointment_id`
is `bigint`. Until these widen to `text`, no adapter with string IDs can be written at all.

**#5 is the subtle one.** `computeLeadOutcome` and `computeConsultOutcome` are pure functions —
good — but they consume raw CareStack status codes. Normalization must move into the adapter so
the rollup operates on our vocabulary, not CareStack's.

**#6 stays per-vendor.** Every EMR signs and shapes webhooks differently; one route per vendor
is correct. Only the post-verification handoff should go through the port.

---

## Target design

### The port

New file `src/lib/ehr/port.ts` — types plus an interface, no logic:

```ts
export type EhrCapability =
  | 'appointment.write'      // can create/cancel in the PMS
  | 'busy.sync'              // can pull occupancy for availability
  | 'patient.search'         // can resolve/create a patient record
  | 'outcomes.sync'          // can pull procedures/invoices for revenue rollup

export interface EhrAdapter {
  readonly source: EhrSource
  readonly capabilities: ReadonlySet<EhrCapability>

  /** Returns null when unconfigured/disabled for this org — never throws. */
  getConfig(supabase: SupabaseClient, organizationId: string): Promise<unknown | null>

  // — booking writeback —
  createAppointment(ctx: EhrCtx, input: CreateAppointmentInput): Promise<{ externalId: string }>
  cancelAppointment(ctx: EhrCtx, externalId: string, reasonCode?: string): Promise<void>

  // — pull-side runners; each idempotent, cursor-driven, deadline-aware —
  syncBusySlots(ctx: EhrCtx, deadlineAt: number): Promise<SyncResult>
  syncOutcomes(ctx: EhrCtx, deadlineAt: number): Promise<SyncResult>
}
```

`capabilities` is what makes an aggregator like Sikka usable: a read-only tier declares
`busy.sync` + `outcomes.sync` without `appointment.write`, and callers degrade rather than
fail. This is exactly the writeback gap flagged in the landscape doc.

Normalized vocabulary lives here too, so the rollup stops reading CareStack codes:

```ts
export type NormalizedProcedureStatus = 'proposed' | 'accepted' | 'completed' | 'rejected'
export type NormalizedApptOutcome = 'scheduled' | 'completed' | 'no_show' | 'cancelled'
```

Reuse the existing `SyncResult` shape the cron already aggregates
(`{ resource, fetched, upserted, events_emitted, status, error? }`) so the cron's result
assembly and `withCron` heartbeat are untouched.

### The registry

`src/lib/ehr/registry.ts` — the only file that grows per EMR:

```ts
const ADAPTERS: Record<string, EhrAdapter> = { carestack: carestackAdapter }

/** Adapters configured AND enabled for this org, in connector_configs order. */
export async function getEnabledAdapters(
  supabase: SupabaseClient, organizationId: string,
): Promise<Array<{ adapter: EhrAdapter; config: unknown }>>
```

Discovery keeps using `connector_configs` exactly as today, just filtered to `connector_type IN
(…adapter keys)` instead of `= 'carestack'`.

---

## Implementation steps

Each step ships independently and leaves the system working. Steps 1–2 are pure prep and carry
the real risk; 3–5 are mechanical.

### Step 1 — widen ID columns *(migration, no code)*

New migration widening every external-ID column to `text`:

- `ehr_appointments.ehr_appointment_id` → `text` (drop/recreate the unique index and
  `idx_ehr_appointments_org_status`)
- `treatment_procedures.ehr_procedure_id`, `.ehr_treatment_plan_id`, `.ehr_appointment_id`,
  `.ehr_provider_id`, `.ehr_location_id` → `text`
- `invoices.ehr_invoice_id`, `.ehr_provider_id`, `.ehr_location_id` → `text`
- `treatment_plans.ehr_treatment_plan_id` → `text`

`USING col::text` preserves existing rows. Update the matching `number` fields in
`src/types/database.ts` to `string`, then fix the resulting type errors in
`carestack/{sync,rollup,appointments}.ts` — these are comparison/lookup sites, so prefer keeping
map keys as strings throughout rather than re-parsing.

> Check `docs/MIGRATION_DRIFT.md` before writing this — the repo has a known drift log and the
> live column types must be confirmed against it, not assumed from the migration files.

### Step 2 — normalize statuses at the adapter boundary

Move the CareStack enum knowledge out of shared logic:

- Keep `PROC_STATUS_ACCEPTED`/`PROC_STATUS_COMPLETED` inside `carestack/`, and add a mapper to
  `NormalizedProcedureStatus`. Same for the consult-status strings at `rollup.ts:277`.
- Change `computeLeadOutcome` and `computeConsultOutcome` to take normalized values.
- These are pure functions with existing tests (`carestack-rollup.test.ts`) — update fixtures to
  normalized values; the assertions should not change. **If a rollup assertion changes, the
  mapping is wrong.**

### Step 3 — define the port, wrap CareStack as adapter #1

Add `port.ts` and `registry.ts`. Add `carestack/adapter.ts` implementing `EhrAdapter` by
delegating to the existing functions. No behavior change, no logic moves — it is an adapter
object over code that already works, declaring all four capabilities.

### Step 4 — route the booking seam through the registry

In `ehr-sync.ts`, replace `runCareStackLeg` with a loop over `getEnabledAdapters()`, skipping
any adapter lacking `appointment.write`. Preserve exactly:

- **fire-and-forget** — the seam must still never throw back into booking (`:167`);
- **per-leg independence** — one adapter failing must not skip the others or the Dion leg;
- **idempotency** — the `carestack_appointment_id` short-circuit at `:63` becomes a per-source
  external-ID lookup;
- the `ehr_sync_failed` activity log per failed leg.

**Storage for external IDs.** Rather than adding a column per vendor, add
`appointments.ehr_external_ids jsonb` (`{ "carestack": "12345" }`) and
`appointments.ehr_sync_status jsonb`. Backfill from `carestack_appointment_id` /
`carestack_sync_status` in the same migration and keep the old columns as generated/synced
mirrors for one release so nothing reading them breaks — including the ehr-appointment-sync
cron that re-drives `pending`/`failed` legs. Drop them in a follow-up.

Do the same for `booking_settings.carestack_*` → a per-source `settings` JSONB blob, since
"location/provider/operatory/appointment type" is CareStack's model and will not generalize
cleanly to an aesthetics EMR.

### Step 5 — generalize the cron

Rename `carestack-sync` → `ehr-sync`, and loop `org × adapter` instead of `org` alone. Keep the
existing time-budget machinery exactly as-is — `RUN_BUDGET_MS`, the `overBudget()` checks
between runners, partial-cursor persistence, and the `truncated` flag. That logic exists because
the function was being hard-killed before it could heartbeat; **more adapters make the budget
pressure worse, not better**, so the deadline must be threaded into every adapter runner via the
`deadlineAt` parameter on the port.

Keep the old route path as a thin forwarder for one deploy so the Vercel cron entry in
`vercel.json` can be updated without a gap.

---

## Files touched

| File | Change |
|---|---|
| `src/lib/ehr/port.ts` | **new** — interface, capabilities, normalized types |
| `src/lib/ehr/registry.ts` | **new** — adapter map + `getEnabledAdapters` |
| `src/lib/ehr/carestack/adapter.ts` | **new** — thin `EhrAdapter` over existing functions |
| `src/lib/ehr/carestack/rollup.ts` | status mapping moves in; pure fns take normalized input |
| `src/lib/booking/ehr-sync.ts` | `runCareStackLeg` → registry loop |
| `src/app/api/cron/carestack-sync/route.ts` | → `ehr-sync`, `org × adapter` loop |
| `src/types/database.ts` | numeric `ehr_*_id` → `string`; new jsonb columns |
| `supabase/migrations/` | 2 migrations: ID widening; external-ID/settings jsonb + backfill |
| `src/lib/booking/ehr-busy.ts` | **unchanged** — already vendor-neutral |
| `src/app/api/webhooks/carestack/route.ts` | **unchanged** — per-vendor by design |

## Verification

1. `npm run build` and the existing suites — `carestack-rollup`, `carestack-appointments`,
   `carestack-busy-sync`, `carestack-scheduler`, `ehr-sync`, `ehr-busy`. **These must pass
   unmodified except for Step 2's normalized fixtures.** Any other change to an assertion means
   behavior drifted.
2. New `ehr-registry.test.ts`: two fake adapters, one lacking `appointment.write` — assert the
   write is skipped (not failed), the other still runs, and a throwing adapter does not prevent
   the other legs or the Dion leg.
3. Migration rehearsal on a Supabase branch: apply both migrations against a copy with real
   rows, then confirm `ehr_appointments`/`treatment_procedures`/`invoices` row counts are
   unchanged and no `ehr_*_id` is null where it was previously set.
4. End-to-end against the CareStack sandbox: book through the public booking route, confirm the
   appointment appears in CareStack and `ehr_external_ids->>'carestack'` is populated; cancel and
   confirm the cancel propagates. Then run the renamed cron and confirm busy slots, procedures,
   and invoices still land and the rollup still writes lead outcome columns.
5. Confirm no consent-path change: the opt-out-only gate (`src/lib/consent/gate.ts`) is
   untouched by this work.

## Definition of done

Adding EMR #2 requires: one new directory under `src/lib/ehr/`, one line in `registry.ts`, one
`connector_type` value in the check constraint, and one webhook route if the vendor pushes.
**No changes to `ehr-sync.ts`, the cron, the rollup, or any table schema.**
