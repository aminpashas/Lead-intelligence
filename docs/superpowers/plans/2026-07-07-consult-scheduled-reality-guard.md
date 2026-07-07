# Plan: Make "Consultation Scheduled" mean a real booking (GHL reconcile reality-guard)

**Date:** 2026-07-07
**Org affected:** SF Dentistry (`fa64e53c-3d9b-493e-b904-59580cb3f29c`) — the only GHL-reconciled org
**Status:** DRAFT — not built. Read-only investigation complete.

## Problem (evidenced)

The Pipeline board's **Consultation Scheduled** column is not a booking queue. Verified against prod 2026-07-07:

- 411 leads in the stage → **0** have any row in `appointments`; **0** have a future consult date.
- The entire SF org has exactly **1** `appointments` row (a test for today).
- The funnel is inverted (Treatment Presented 2,413 > Consult Completed 1,366 > Consult Scheduled 411) — a bulk-import signature, not real progression.

**Root cause:** `src/lib/ghl/reconcile-map.ts` maps GHL stages `appointment scheduled` / `booked appointment` / `scheduled virtual consult` / `lead contacted - appointment scheduled` / `virtual appointment` → `consultation-scheduled` **unconditionally** (lines 90–95). `reconcile.ts` (GHL-authoritative) then sets `stage_id` with no check that a real booking exists. GHL's label is treated as ground truth for a calendar event LI can't see.

This also means **any manual stage correction reverts**: the reconcile cron ran today at 08:03 UTC (19,622 events in 7 days) and will move a hand-moved lead straight back to `consultation-scheduled` on its next pass.

## Goal

A lead lands in / stays in **Consultation Scheduled** only when LI can confirm a real, future booking. A GHL "appointment scheduled" opp with no verifiable booking must not assert one — it should reconcile to `contacted` (worked, not booked) instead.

This is symmetric with the existing `DEMOTING_SLUGS` / `hasLiEngagement` guard philosophy already in `reconcile.ts` (lines 51–77, 266–278): "a stale GHL signal must not overwrite LI reality." Here: "a GHL booking *claim* must not overwrite the absence of a booking."

## Design

### 1. Define a "real booking" signal (pure, testable)

A lead has a real booking when either:
- an `appointments` row exists with `scheduled_at > now()` and `status NOT IN ('canceled','no_show')`, **or**
- `leads.consultation_date > now()` (covers Cal.com / booking paths that stamp the lead).

Add `hasRealBooking(lead, appts)` next to `hasLiEngagement` in `reconcile.ts`, unit-tested with no I/O.

### 2. Load the booking signal in Phase B

Phase B (lines 211–231) already pages every org lead. Add a lightweight companion load of **future, active appointments** for the org (one indexed query: `organization_id = ? AND scheduled_at > now() AND status NOT IN ('canceled','no_show')`), keyed by `lead_id`. Also select `consultation_date` into the lead row. Cheap — the appointments table is tiny.

### 3. Gate the `consultation-scheduled` target in Phase C

In the write-set loop (lines 266–278), before applying a `consultation-scheduled` target:

```
const claimsBooking = plan.target.stageSlug === 'consultation-scheduled'
const unverified = claimsBooking && !hasRealBooking(lead, futureApptsByLead)
const effectiveSlug = unverified ? 'contacted' : plan.target.stageSlug
```

Use `effectiveSlug` for `targetStageId` + the `stage_changed` activity. Net effect: unverified GHL "appointment scheduled" reconciles to **Contacted**, not Consultation Scheduled. Once a real booking exists (staff `POST /api/appointments`, public `/book`, or Cal.com webhook writes the appointment row), the next reconcile promotes them correctly.

**Why map down to `contacted` and not "leave as-is":** leaving current-stage risks stranding leads in whatever stale stage they were in. `contacted` is the honest floor: "we've worked them, no confirmed consult."

### 4. Backfill (one-time, read-only-then-write)

After the guard ships, run the reconcile once in the normal cron path — it will pull the ~411 (minus any with a real booking) out of Consultation Scheduled into Contacted automatically. No separate migration needed; the guard makes the existing engine self-correcting. The **Bucket A cleanup** (`scripts/cleanup/bucket-a-consult-scheduled-reconcile.sql`, 17→Consultation Completed / 4→Lost) can then run and will stick, because those leads' GHL opps will reconcile to `contacted`/their status floor rather than back to `consultation-scheduled`.

## Sequencing (important)

1. Ship the reality-guard (this plan).
2. Let one reconcile pass run → Consultation Scheduled empties to only genuinely-booked leads (currently 0).
3. Run the Bucket A cleanup script → the 21 attended-but-mislabeled leads settle into their correct terminal stage.

Running the cleanup **before** step 1 = reverted within hours.

## Testing

- Unit: `hasRealBooking` truth table (future appt / past appt / canceled appt / no appt / future consultation_date / past).
- Unit: Phase-C gating — `consultation-scheduled` target with no booking → `contacted`; with booking → stays.
- `tsc --noEmit` must pass (Vercel blocks on type errors, incl. tests).
- Dry-run the reconcile (`reconcileGhlStages(..., { dryRun: true })`) against SF and confirm `afterDistribution['consultation-scheduled']` collapses to ~0 and `contacted` absorbs the difference.

## Out of scope / follow-ups

- **Real GHL calendar sync** (creating actual `appointments` rows from GHL Calendar API) — larger; `searchOpportunities` doesn't carry appointment datetimes. Tracked separately.
- GHL "no show" / "no showed to virtual" currently flatten to `contacted` (reconcile-map lines 129–130) — losing no-show signal. Consider a dedicated path once real bookings flow.

## Risk / safety

- Guard is additive and org-scoped (only GHL-reconciled orgs). Non-GHL orgs unaffected.
- No sends involved; messaging hard-stop (`MESSAGING_DRY_RUN=1`) unaffected either way.
- Reversible: revert the guard commit → reconcile returns to prior behavior.
