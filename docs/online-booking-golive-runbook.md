# Online Booking (CareStack + Dion Clinical + Slack) — Go-Live Runbook

Everything code-side is done, tested, and live-verified against the real CareStack
account; the prod migrations are applied; and the practice org is configured
(`is_enabled=true`, `carestack_location_id=1002` SF). What remains needs human
review or access I don't have. Do these 3 steps.

Practice org: `fa64e53c-3d9b-493e-b904-59580cb3f29c` (Dion Health / Dr. Samadian).
CareStack account 10300; connector already live.

---

## ✅ Already done (no action)
- **Code:** PR #35 (`feat/online-booking-clean`) — green (`tsc` + tests).
- **Prod schema:** both migrations applied (`appointments` sync cols, `booking_settings`
  CareStack defaults, `organizations.dion_practice_id`, `ehr_busy_slots`).
- **CareStack:** connector configured + credentials validated; reads + writes + the
  patient/appointment DTOs proven against the live API (incl. a booked+deleted test).
- **booking_settings:** enabled + SF clinic default.

## ⚠️ Security first
Rotate the Supabase Personal Access Token (it was decoded during migration apply):
supabase.com/dashboard/account/tokens → revoke → regenerate → `supabase login`.

---

## Step 1 — Deploy the code
PR #35 is stacked on `feat/phone-first-booking`. Merge it up your branch stack to
`main`; Vercel auto-deploys `main`. Review the diff, then merge. (Additive migrations
are already live, so the new code activates cleanly on deploy.)

**Smoke test after deploy:** open `/book/fa64e53c-3d9b-493e-b904-59580cb3f29c`, book a
test slot with a real DOB → confirm (a) the appointment appears in CareStack, (b) an
`appointment.booked` event reaches Dion Clinical (after Step 3), (c) Slack pings (after
Step 2). Then cancel/delete the test in CareStack.

## Step 2 — Slack "Consultation Booked" notifications
1. Slack → **Create an app** (api.slack.com/apps) → *From scratch* → pick the workspace
   + a channel (e.g. #bookings).
2. **Incoming Webhooks** → toggle **On** → *Add New Webhook to Workspace* → choose the
   channel → copy the `https://hooks.slack.com/services/…` URL.
3. Seed it into the practice org (CareStack is already seeded, so only Slack is added):
   ```bash
   BOOKING_ORG_ID=fa64e53c-3d9b-493e-b904-59580cb3f29c \
   SLACK_WEBHOOK_URL=https://hooks.slack.com/services/… \
   npx tsx scripts/seed-booking-ehr.ts
   ```
   A booked consult now posts a "📅 Consultation Booked" card; no-shows post "⚠️".

## Step 3 — Dion Clinical event bridge
The receiver is at dion-clinical's Vercel deployment, which has **Deployment Protection
ON** — external POSTs are 401'd before reaching it. So:
1. **dion-clinical** repo/Vercel → Settings → **Deployment Protection** → allow the
   production URL (or set a protection bypass), and set env **`DION_BUS_SECRET`** to a
   strong shared secret.
2. **Lead Intelligence** Vercel → Environment Variables (Production) → add:
   - `DION_CLINICAL_URL = https://dion-clinical-<current-prod>.vercel.app`
   - `DION_BUS_SECRET = <same value as dion-clinical>`
3. Redeploy LI. A booked/cancelled consult now emits `appointment.booked` /
   `appointment.cancelled` to Dion Clinical's `/api/bus/receive` (deterministic envelope
   ids → idempotent; retry cron backstops failures).
4. *(Optional)* set `organizations.dion_practice_id` for the org so events carry a real
   `dionPracticeId` (null is valid for v1).

---

## Notes / knobs
- **Default clinic:** `booking_settings.carestack_location_id` = `1002` (SF). Others:
  `2003` Antioch, `5050` Palo Alto, `9034` Beverly Hills. Also settable:
  `carestack_provider_id` / `carestack_operatory_id` (else the adapter uses the first
  from the API).
- **DOB:** captured at booking intake → real CareStack `dob`. Legacy leads with no DOB
  get a `1900-01-01` stub for staff to complete (gender defaults to CareStack "Not Set").
- **Inactive CareStack patients:** a returning patient marked inactive → the CareStack
  leg fails gracefully (`carestack_sync_status='failed'`, logged); staff reactivate.
  The adapter never silently reactivates a patient.
- **Reliability:** all EHR/Slack legs are fire-and-forget and never block a booking; the
  `ehr-appointment-sync` cron re-drives any `pending`/`failed` leg.
