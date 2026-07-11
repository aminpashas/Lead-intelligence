# Team-controlled card-on-file (no-show protection)

**Date:** 2026-07-09
**Branch:** feat/pipeline-stage-restructure (feature branch — never merge to main directly)
**Status:** Approved design → implementation

## Goal

Let the practice team text a lead a link to save a credit card on file so a no-show
can be charged automatically, and let them do it **at the moment they book**. The
Stripe engine that does this already exists and is live; this work makes it
**visible and controllable by the team**, and adds a **mandatory** mode.

## What already exists (do not rebuild)

- `src/lib/stripe/no-show-fee.ts`
  - `createCardCaptureSession()` — hosted Stripe Checkout in `mode:'setup'` (saves a
    card, charges nothing). Customer + metadata scoped to an `appointment_id`.
  - `sendCardCaptureLink()` — texts the link to the lead (SMS only, consent-gated).
  - `chargeNoShowFeeForAppointment()` — off-session charge on no-show, idempotent.
- `POST /api/appointments/[id]/card-setup` — mints a fresh link URL (does **not** send).
- Auto-send wired into staff booking (`/api/appointments` POST), patient self-book
  (`/api/booking/[orgId]/book`), and autopilot — all gated on `no_show_fee_enabled`.
- Stripe webhook `checkout.session.completed` (mode=setup, purpose=`no_show_card_on_file`)
  → `storeCardOnFile()` sets `appointments.card_on_file=true` + customer + payment method.
- Settings: `booking_settings.no_show_fee_enabled`, `.no_show_fee_cents` (default 5000).
- `appointments.status`: `scheduled | confirmed | completed | no_show | canceled | rescheduled`.

## The gap

The capability is invisible and fully automatic. The team's manual booking dialog
(`schedule-appointment.tsx`) gives the rep no control, no confirmation, and no resend.
The `card-setup` endpoint that would enable resend is wired to no UI and only returns a
URL. There is no way to require a card before an appointment is confirmed.

## Design

### Modes (two settings)

| `no_show_fee_enabled` | `card_on_file_required` (NEW) | Behaviour |
|---|---|---|
| off | — | No card-on-file anywhere. Unchanged. |
| on  | false (optional) | Rep-controlled. Toggle in Schedule dialog (default ON) + standalone Send/Resend button on the lead. |
| on  | true (required)  | A **confirmed** appointment cannot exist without a card. Booking creates a held `pending_card` slot; card link auto-sends; webhook flips it to `scheduled`. Manager/Super-Admin override available. |

- **`card_on_file_required`** is a **Super-Admin / agency-admin controlled** per-practice
  toggle (the "make it mandatory" button). Practice staff see its effect, can't flip it.
- Manual send stays **gated on `no_show_fee_enabled`** (approved): the disclosure text and
  the charge engine both need the fee configured.

### `pending_card` held-slot mechanism (required mode)

Rather than a lead-level card store (rejected — schema churn), reuse appointment-scoping:

1. Booking with `card_on_file_required` creates the appointment in new status
   `pending_card` instead of `scheduled`.
2. `pending_card` is excluded from confirmed views: calendar "booked" counts,
   confirmed-appointment lists, and appointment reminders. It is a held slot only.
3. The card link auto-sends (existing `sendCardCaptureLink`).
4. `storeCardOnFile()` (webhook), after setting `card_on_file=true`, flips
   `status: 'pending_card' → 'scheduled'` (only when currently `pending_card`).
5. **Override:** a Super-Admin/manager can confirm a `pending_card` appointment without a
   card (patient read the card over the phone, VIP, etc.), mirroring the existing
   `appointment_scheduled_gate_override` pattern. Logged as an activity.

### UI

**A. Schedule dialog (`schedule-appointment.tsx`)** — the "while booking" surface.
- When `no_show_fee_enabled` and NOT required: a checkbox "Text card-on-file link
  ($X no-show fee)", default checked. Passes `send_card_link` to the POST body.
- When required: replace the checkbox with a non-editable notice: "A card on file is
  required — the patient will be texted a link and the appointment confirms once saved."
- After booking, toast reflects what happened ("Appointment scheduled — card link texted"
  / "Held — waiting for card on file").

**B. Standalone button (`lead-actions.tsx`)** — resend / send any time.
- New action button "Card link" (icon: `CreditCard`), following the existing `prequalEnabled`
  Pre-Qual button pattern. Rendered only when `no_show_fee_enabled` for the org
  (new `noShowFeeEnabled` prop, plumbed like `prequalEnabled`).
- Reflects state where cheaply known: default label "Card link"; disabled with reason
  when the lead has no reachable phone.
- Click → `POST /api/leads/[id]/card-on-file`.

### API

**New:** `POST /api/leads/[id]/card-on-file`
- Resolves the lead's active upcoming appointment (soonest future, not canceled/completed).
- 409 `{ error: 'no_upcoming_appointment' }` if none — UI toasts "Book an appointment first".
- Else calls `sendCardCaptureLink()` for that appointment; returns `{ sent, appointment_id }`.
- Gated on `no_show_fee_enabled`.

**Changed:** `/api/appointments` POST
- Accept optional `send_card_link` (boolean) in the body.
- Read `card_on_file_required` from `booking_settings`.
- If required → create appointment as `pending_card`, always send the link.
- Else if `no_show_fee_enabled` AND `send_card_link !== false` → current behaviour (send).
- Else → no card link.

**Changed:** `/api/appointments` PATCH `validStatuses`
- Add `pending_card` is NOT a manually-settable status (keep it out of `validStatuses`);
  only the booking POST and the webhook set/clear it. Add an explicit override path to
  move `pending_card → scheduled` (Super-Admin/manager only, logged).

**Changed:** Stripe webhook `storeCardOnFile()`
- After marking `card_on_file=true`, if the appointment is `pending_card`, update
  `status='scheduled'`. Guarded so it never downgrades a further-along status.

### Settings surface

- `booking-protocol-settings.tsx` (or the booking settings page): add the
  `card_on_file_required` toggle, visible/editable **only to agency-admin / super-admin**.
  Practice-admins see it read-only with an explanatory caption.

### Data / migration

New migration (idempotent, `ADD COLUMN IF NOT EXISTS`):
```sql
ALTER TABLE public.booking_settings
  ADD COLUMN IF NOT EXISTS card_on_file_required boolean NOT NULL DEFAULT false;
```
`appointments.status` gains the `pending_card` value. The column is text/enum —
confirm in-repo; add a CHECK/enum value only if one is enforced. Update
`src/types/database.ts` for both.

## Error handling & edge cases

- Card capture failures never block booking (existing contract in `no-show-fee.ts`).
- `pending_card` appointments must not appear as confirmed bookings or fire reminders.
- Resend on a lead with no upcoming appointment → clear 409 + toast, no send.
- Override to confirm without a card is logged as a lead activity.
- **Prod reality:** `MESSAGING_DRY_RUN=1` is active in production (messaging hard-stop),
  so texts will not physically send until that is lifted. Build + verify in dry-run;
  do not treat "no SMS arrived in prod" as a bug.

## Testing

- Unit: booking POST branch table (fee off / optional+send / optional+skip / required).
- Unit: webhook flips only `pending_card → scheduled`, never downgrades.
- Unit: `/api/leads/[id]/card-on-file` 409 when no upcoming appointment.
- Manual/dry-run: Schedule dialog checkbox + required notice; standalone resend; override.

## Out of scope (YAGNI)

- Lead-level card capture with no appointment (explicitly rejected).
- Email delivery of the card link (SMS only, matching existing flow).
- Charging anything at capture time (setup-mode only).

## Known limitation / follow-up

- **AI autopilot booking does not enforce the mandatory hold.** The autopilot
  `book_appointment` tool (`src/lib/autopilot/agent-tools.ts`) still books a
  confirmed appointment and texts a "Confirmed!" message, then sends the card
  link when the fee is enabled — it does **not** create a `pending_card` held
  slot when `card_on_file_required` is on. This is acceptable for now because
  autopilot booking is gated off in production (messaging hard-stop + autopilot
  scoping). If autopilot booking is turned on with mandatory card-on-file, this
  path needs the same held-slot treatment and a reworded confirmation.
