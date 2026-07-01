# Online Booking Module — CareStack + Dion Clinical Integration

**Date:** 2026-07-01
**Status:** Design approved (pending spec review) → implementation plan next
**Branch (proposed):** `feat/online-booking-ehr`

---

## 1. Problem

The AI setter currently tells leads *"our online booking is unavailable right now — just give us a call"* (see the SMS screenshot that kicked this off). That message is the AI hitting the `booking_settings`-missing fallback in
[`executeCreateBooking`](../../../src/lib/autopilot/agent-tools.ts) (`agent-tools.ts:694`).

More fundamentally, LI's booking is **entirely local**: slots come from `booking_settings.weekly_schedule` and appointments are written only to LI's own `appointments` table. They never reach the systems the practice and clinical team actually run on:

- **CareStack** — the third-party PMS the front desk lives in. It has no idea an online booking happened.
- **Dion Clinical** — the in-house EMR/chart. It anchors recall and shows upcoming visits off `appointment.*` events, and receives none.

**Goal:** make LI's booking engine EHR-backed — write confirmed bookings into CareStack (two-way, incl. real-availability read) and emit `appointment.*` to Dion Clinical — without breaking the local booking flow that already works.

## 2. Goals / Non-goals

**Goals**
- Confirmed bookings (public widget, AI, voice) create a real CareStack appointment and emit an `appointment.*` event to Dion Clinical.
- Cancellations / no-shows propagate to both (`PUT /appointments/{id}/cancel`, `appointment.cancelled`).
- Availability the AI/widget offer reflects **real CareStack chair occupancy** (two-way read), so we never offer a taken slot.
- The phone-first gate maps cleanly onto the event contract (call-requested → `appointment.requested`).
- **A booked consult posts a Slack notification** to the practice's channel (staff visibility).
- Neither external call can block or fail the local booking / confirmation SMS+email.

**Non-goals (v1)**
- No central Dion **hub** outbox for LI (we use a direct point-to-point bridge to Dion Clinical; hub-fanout is a later upgrade).
- No provider-schedule import from CareStack for open *hours* — v1 keeps open hours in `booking_settings.weekly_schedule` and only overlays real CareStack *occupancy*. (Provider working-hours reconciliation is a fast-follow.)
- No Master-Records `dionPatientId` resolution — v1 emits `dionPatientId: null` (the contract allows it).
- No 3D/scheduling-engine extraction — LI **is** "Patient Engagement" and emits `appointment.*` now (decision below).

## 3. Decisions (locked with the user)

| Decision | Choice |
|---|---|
| CareStack direction | **Two-way** (write-back + real-availability read) |
| Dion Clinical connection | **Direct bridge** (POST to `/api/bus/receive`), not a hub outbox |
| CareStack client | **Align LI's existing client** to MDRCM's proven host/auth + add appointment/operatory/provider methods |
| Federation role | **LI is "Patient Engagement"** and emits `appointment.*` now; bridge kept extractable |
| Slack on booking | **Reuse the existing connector dispatcher** — the seam dispatches `consultation.scheduled`, which the per-org Slack connector already renders (not a one-off webhook) |

## 4. Current state (what already exists — reuse, don't rebuild)

**LI booking (works, local):**
- Availability engine [`src/lib/booking/availability.ts`](../../../src/lib/booking/availability.ts) — `generateAvailableSlots(config, existingAppointments)`. Already subtracts existing appointments; this is the seam for real occupancy.
- Public page/widget [`src/app/book/[orgId]/page.tsx`](../../../src/app/book/[orgId]/page.tsx), [`src/components/booking/booking-widget.tsx`](../../../src/components/booking/booking-widget.tsx).
- Public API [`/api/booking/[orgId]/slots`](../../../src/app/api/booking/[orgId]/slots/route.ts) + [`/book`](../../../src/app/api/booking/[orgId]/book/route.ts) — phone-first gate, no-show-fee card capture, consent, SMS/email confirms.
- AI tools `executeGetAvailableSlots` / `executeCreateBooking` in [`agent-tools.ts`](../../../src/lib/autopilot/agent-tools.ts).
- Phone-first gate [`src/lib/booking/call-gate.ts`](../../../src/lib/booking/call-gate.ts).

**LI connectors (Slack works, but booking doesn't fire it):**
- Per-org connector dispatcher [`src/lib/connectors/dispatcher.ts`](../../../src/lib/connectors/dispatcher.ts) (`dispatchConnectorEvent`, `buildConnectorLeadData`), fire-and-forget, fans one event to all configured connectors (Slack, Meta, GA4, Google Ads, webhooks) per `connector_configs`.
- Slack connector [`src/lib/connectors/slack/notify.ts`](../../../src/lib/connectors/slack/notify.ts) — Block Kit cards incl. `consultation.scheduled` ("📅 Consultation Booked"), `consultation.no_show`, `appointment.booked`. Respects each webhook's subscribed-events list.
- ⚠️ These only fire on **funnel stage changes** ([`funnel/executor.ts:122`](../../../src/lib/funnel/executor.ts)). The **booking routes / AI tool fire no connector event**, so bookings don't reach Slack today.

**LI EHR (read-only today):**
- [`src/lib/ehr/carestack/client.ts`](../../../src/lib/ehr/carestack/client.ts) — OAuth + generic `carestackFetch`. ⚠️ **Wrong host/auth** (`api.carestack.com` + account-id header). Must align to MDRCM's proven `pmsglobal.carestack.com` + JWT-only.
- `sync.ts` (patients/procedures/invoices — read only), webhook `/api/webhooks/carestack`, cron `carestack-sync`.
- Migration `026_phase3_carestack.sql`: a `patients` table with `ehr_patient_id`/`ehr_source`, and **`appointments.ehr_appointment_id`** already exists.

**Proven CareStack API (reference: `~/medicaldentalrcm/src/lib/carestack/`):**
- Host `https://pmsglobal.carestack.com`; token `https://id.carestack.com/connect/token` (OAuth2 password grant, account from JWT, no account-id header). Client version v1.0.54 (Jan 2026).
- `POST /api/v1.0/appointments` (body ≈ `CsAppointment`), `PUT /api/v1.0/appointments/{id}/cancel`, `GET /api/v1.0/appointments/{id}`, `GET /api/v1.0/operatories`, `GET /api/v1.0/providers`, `GET /api/v1.0/locations`, `POST /api/v2.0/patients/search`, `POST /api/v1.0/patients`, `GET /api/v1.0/sync/appointments?modifiedSince=`.
- **No open-slots endpoint** — availability is derived from operatories/providers + existing appointments.
- `CsAppointment` fields: `patientId, locationId, providerId, operatoryId?, scheduledStart, scheduledEnd, duration, appointmentType, cdtCodes?, status, isNewPatient, notes?`.

**Dion Clinical (reference: `~/dion-clinical/`):**
- Consumes `appointment.*` at `POST /api/bus/receive`, auth `x-forward-secret` (= `DION_BUS_SECRET`, currently `dion-demo-bus`), validates against `lib/dion/consumed.ts`, records idempotently by envelope `id`. Direct authenticated POST is accepted.
- Envelope (`lib/dion/envelope.ts`): `{ id: uuid, envelopeVersion: 1, source: <product>, occurredAt: ISO, dionPracticeId: string|null, idempotencyKey?, traceId?, type, data }`. `lead-intelligence` is a valid `source`.
- Appointment contract (`lib/dion/events/appointment.ts`):
  - `appointment.requested` — `{ appointmentId, dionPatientId: string|null }`
  - `appointment.booked` — `{ appointmentId, dionPatientId: string|null, startsAt: ISO }`
  - `appointment.cancelled` — `{ appointmentId, reasonCode? }` (e.g. `"patient-cancel" | "no-show" | "reschedule"`)

## 5. Architecture — one seam, two adapters

```
  Public /book route ─┐
  AI executeCreateBooking ─┼─▶  appointments row written  ─▶  syncAppointmentToEhr(appointmentId)   [the seam]
  Voice booking        ┘                                          │                  │
  cancel / no-show ─────────────▶ (same seam, cancel path)        │                  │
                                                     CareStack adapter        Dion Clinical bridge
                                                     find-or-create patient   build dionEvent envelope
                                                     POST/PUT appointment      POST /api/bus/receive
                                                     store ehr_appointment_id  (x-forward-secret)
                                                     set carestack_sync_status set dion_sync_status
                                                          │                          │
                                                   retry cron `ehr-appointment-sync` re-drives failed/pending
```

The seam is **fire-and-forget** from the request path — it never blocks the local booking or the confirmation SMS/email (same principle the book route already uses for SMS/email failures, and connectors use generally).

## 6. Components

### 6.1 CareStack client (align existing) — `src/lib/ehr/carestack/client.ts`
- Change host to `pmsglobal.carestack.com` and token host `id.carestack.com`; drop the account-id header; keep the SSRF host guard (allow `carestack.com` + `*.carestack.com`, already covers `pmsglobal`/`id`).
- Keep `getCareStackConfig` (creds from encrypted `connector_configs`), token cache, 401-retry.
- Add typed methods (mirroring MDRCM): `createAppointment`, `cancelAppointment`, `getAppointment`, `getOperatories`, `getProviders`, `getLocations`, `searchPatients` (v2.0), `createPatient`, `getSyncAppointments(modifiedSince)`.

### 6.2 CareStack appointment adapter — `src/lib/ehr/carestack/appointments.ts`
- `ensureCareStackPatient(supabase, orgId, lead)`: look up `patients.ehr_patient_id` for the lead; else `searchPatients` by name/phone/email; else `createPatient`; persist mapping. Returns CareStack `patientId`.
- `pushAppointmentToCareStack(supabase, orgId, appointment)`: resolve patient → default `locationId`/`providerId`/`operatoryId` (from `booking_settings` new fields or the first CareStack location/provider) → `createAppointment` → store `ehr_appointment_id`.
- `cancelAppointmentInCareStack(supabase, orgId, appointment)`: `PUT /appointments/{ehr_appointment_id}/cancel`.
- Status map: LI `scheduled` → CS `scheduled`; LI `no_show` → CS cancel w/ reason.

### 6.3 CareStack availability overlay (two-way read)
- Extend the existing [`carestack-sync` cron](../../../src/app/api/cron/carestack-sync/route.ts) (or a sibling `carestack-appointments-sync`) to pull `GET /sync/appointments?modifiedSince=` and upsert them into LI `appointments` as `booked_via='carestack'` occupancy rows (or a dedicated `ehr_busy_slots` table).
- `generateAvailableSlots` consumes these unchanged (it already blocks time from existing appointments). Result: AI/widget stop offering taken chairs.
- v1: open **hours** remain `booking_settings.weekly_schedule`; only occupancy comes from CareStack.

### 6.4 Dion Clinical bridge — `src/lib/bridges/dion-clinical.ts`
- Mirrors [`growth-studio.ts`](../../../src/lib/bridges/growth-studio.ts). Config from env: `DION_CLINICAL_URL`, `DION_BUS_SECRET`. SSRF-guard the URL.
- `emitAppointmentEvent(type, data, { dionPracticeId })`: builds `{ ...newEnvelopeMeta('lead-intelligence', dionPracticeId, { idempotencyKey: appointmentId+':'+type }), type, data }` and POSTs to `${DION_CLINICAL_URL}/api/bus/receive` with header `x-forward-secret: DION_BUS_SECRET`. Vendor a minimal envelope+schema builder under `src/lib/bridges/dion/` (byte-faithful to `dion-clinical/lib/dion/events/appointment.ts`) so we validate before sending.
- `source` constant = `'lead-intelligence'` (honest provenance; receiver keys on `type`, not source). `dionPracticeId` from `organizations.dion_practice_id` (nullable v1). `dionPatientId` = `null` v1.
- Returns boolean; never throws to caller.

### 6.5 The seam — `src/lib/booking/ehr-sync.ts`
- `syncAppointmentToEhr(supabase, appointmentId, { action: 'book' | 'request' | 'cancel', reasonCode? })`:
  1. Load appointment + lead + org settings.
  2. CareStack leg (only on `book`/`cancel`, and only if CareStack connector enabled) → set `carestack_sync_status`.
  3. Dion leg → map action→event type, `emitAppointmentEvent` → set `dion_sync_status`.
  4. Connector/Slack leg (see 6.8) → `dispatchConnectorEvent` with `consultation.scheduled` (book) / `consultation.no_show` or none (cancel).
  5. On any leg failure: leave that leg's status `failed`, log to `lead_activities` (`activity_type:'ehr_sync_failed'`), never throw. Legs are independent — Slack still fires if CareStack is down.
- Invoked fire-and-forget (`void syncAppointmentToEhr(...)`) from: public [`/book` route](../../../src/app/api/booking/[orgId]/book/route.ts) (both the confirmed and the call-requested branches), `executeCreateBooking`, the voice booking path, and cancel/no-show handlers.

### 6.8 Slack / connector leg (the "notify on booking" ask)
- On a confirmed booking the seam calls `dispatchConnectorEvent(supabase, { type: 'consultation.scheduled', data: buildConnectorLeadData(lead, { appointment }) })`. This reuses the existing per-org Slack card ("📅 Consultation Booked") and simultaneously keeps Meta/GA4/Google Ads consistent — no bespoke Slack webhook.
- **Config:** the practice's org needs a Slack connector row in `connector_configs` (incoming-webhook URL) subscribed to `consultation.scheduled`. If none is configured, the dispatcher silently skips (no error) — so this is enable-by-config, code always attempts it.
- **No double-fire:** booking routes currently emit *no* connector event, and the funnel executor fires only on pipeline stage moves (a separate trigger), so dispatching here won't duplicate. Implementation adds a guard/idempotency check so a later funnel stage-move to `consultation-scheduled` for the same appointment doesn't re-notify (and, importantly, doesn't double-count Meta/Google Ads conversions).
- Enriches the card with appointment date/time/location via `metadata` so staff see *when* the consult is.

### 6.6 Retry cron — `src/app/api/cron/ehr-appointment-sync/route.ts`
- Guarded by `CRON_SECRET` (pattern of existing crons). Selects appointments where `carestack_sync_status` or `dion_sync_status` in (`pending`,`failed`) with attempts < N, re-drives via the seam, bumps attempts, dead-letters after N. Registered in `vercel.json` (`*/5`).

### 6.7 The screenshot fix — seed `booking_settings`
- The failing org has no `booking_settings` row. Provide a script/settings-UI path to seed it (weekly schedule, slot duration, phone-first flag, no-show fee). Then the AI offers real slots instead of "unavailable."
- New `booking_settings` fields for CareStack defaults: `carestack_location_id`, `carestack_provider_id`, `carestack_operatory_id`, `carestack_appointment_type` (nullable; adapter falls back to first location/provider).

## 7. Data model changes (migration)

New migration `0XX_ehr_appointment_sync.sql`:
- `appointments`: add `carestack_sync_status text default 'pending'`, `dion_sync_status text default 'pending'`, `ehr_sync_attempts int default 0`, `ehr_sync_error text`. (`ehr_appointment_id` already exists.)
- `booking_settings`: add nullable `carestack_location_id`, `carestack_provider_id`, `carestack_operatory_id`, `carestack_appointment_type`.
- `organizations`: add nullable `dion_practice_id text`.
- (Optional) `ehr_busy_slots` table if we don't overlay occupancy directly onto `appointments`.
- Update `src/types/database.ts` to match.

## 8. Event / status mapping

| LI trigger | Dion event | CareStack action | Slack/connector | Notes |
|---|---|---|---|---|
| Call requested (phone-first gate) | `appointment.requested` | — | — | data: `{ appointmentId, dionPatientId:null }` |
| Confirmed booking | `appointment.booked` | `POST /appointments` | `consultation.scheduled` 📅 | data adds `startsAt` |
| Cancel (patient/staff) | `appointment.cancelled` `reasonCode:"patient-cancel"|"reschedule"` | `PUT /appointments/{id}/cancel` | — (optional) | |
| No-show | `appointment.cancelled` `reasonCode:"no-show"` | `modify-status` → no_show or cancel | `consultation.no_show` ⚠️ | ties into existing no-show fee flow |

`appointmentId` on the wire = LI's `appointments.id` (stable, idempotency-friendly). Dion resolves detail by calling back with identifiers; no PHI on the bus.

## 9. Reliability & security
- Fire-and-forget; retries via cron; per-leg status; dead-letter after N attempts; failures visible in `lead_activities`.
- Idempotency: Dion keys on envelope `id` (+ we set `idempotencyKey = appointmentId:type`); CareStack guarded by storing/reading `ehr_appointment_id` (don't double-create).
- SSRF guards on both `carestack.com` host and `DION_CLINICAL_URL`.
- Creds encrypted in `connector_configs`. **LI is islanded** → CareStack creds must be seeded into LI's own encrypted store (they exist in MDRCM; copy, don't share a DB).
- No PHI on the Dion bus (identifiers/enums/timestamps only — enforced by the vendored schema).

## 10. Testing
- CareStack: appointment body mapping, patient find-or-create (hit/miss/create), cancel path, host/auth alignment (unit, mocked fetch).
- Dion bridge: envelope built valid against the vendored appointment schema for all three types; POST auth header; graceful failure when unconfigured.
- Seam: book/request/cancel drive the right legs; failure sets `failed` + logs + never throws; retry cron re-drives and dead-letters.
- Availability overlay: CareStack occupancy blocks the right slots in `generateAvailableSlots`.
- `tsc --noEmit` green before any push to a branch that deploys (Vercel fails on TS errors, incl. tests).

## 11. Env / config
- `DION_CLINICAL_URL` (e.g. `https://dion-clinical-...vercel.app`), `DION_BUS_SECRET` (match Dion Clinical).
- CareStack creds in `connector_configs` (`connector_type='carestack'`): `client_id`, `client_secret`, `username`, `password` (+ existing settings). Align to JWT-only auth.
- Slack: per-org `connector_configs` (`connector_type='slack'`) incoming-webhook URL, `events` incl. `consultation.scheduled` (+ `consultation.no_show`). No env var — it's per-tenant config. Seed Dion Health's practice org.
- `.env.local.example` updated.

## 12. Phasing / sequencing
1. **Migration + client alignment** — schema, `database.ts`, align CareStack client to `pmsglobal`/JWT, add appointment/operatory/provider methods. (Self-contained, testable.)
2. **Dion Clinical bridge** — vendored envelope/schema + `emitAppointmentEvent`; unit-verified against the consumed schema. (Fully in our control; both repos local.)
3. **The seam + wire the write-sites** — `syncAppointmentToEhr`, call from public/AI/voice + cancel; **Slack/connector leg (`consultation.scheduled`) with dedup guard**; retry cron; the "unavailable" fix via seeded `booking_settings`. (Slack lands here — it's independent of the CareStack leg, so staff get booking notifications even before Phase 4.)
4. **CareStack write leg** — `ensureCareStackPatient` + `pushAppointmentToCareStack` + cancel, behind the connector-enabled flag.
5. **CareStack availability overlay (two-way read)** — occupancy sync → engine.

Each phase gets its own plan → implementation → verification loop.

## 13. Assumptions / open items
- Direct POST to Dion Clinical `/api/bus/receive` with the shared secret is accepted without the hub (confirmed by the receiver code). If the hub must mediate later, only the bridge target changes.
- `organizations → dion_practice_id` mapping is TBD per org; `null` is valid for v1.
- CareStack default location/provider/operatory per org must be captured in `booking_settings` (or defaulted to the first from the API) before write-back can succeed.
- `CsAppointment.appointmentId` is typed `string` in MDRCM but `appointments.ehr_appointment_id` is `integer` — reconcile type during implementation.
