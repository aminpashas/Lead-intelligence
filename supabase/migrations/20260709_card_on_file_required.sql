-- Team-controlled card-on-file: mandatory mode + held-slot status.
--
-- 1. booking_settings.card_on_file_required — a Super-Admin (agency_admin)
--    controlled per-practice switch. When true, a consultation cannot become a
--    *confirmed* appointment until the patient saves a card on file: booking
--    creates a held `pending_card` slot and the Stripe webhook flips it to
--    `scheduled` once the card lands. Defaults false so existing orgs are
--    unaffected. Only meaningful when no_show_fee_enabled is also true.
--
-- 2. appointments.status gains 'pending_card' — a held slot that is NOT a
--    confirmed booking (excluded from reminders, calendar counts, etc.).

ALTER TABLE public.booking_settings
  ADD COLUMN IF NOT EXISTS card_on_file_required boolean NOT NULL DEFAULT false;

-- Widen the appointments status CHECK to allow the held-slot value. The original
-- constraint (004_campaigns.sql) is the auto-named appointments_status_check.
ALTER TABLE public.appointments DROP CONSTRAINT IF EXISTS appointments_status_check;
ALTER TABLE public.appointments ADD CONSTRAINT appointments_status_check
  CHECK (status IN (
    'scheduled', 'confirmed', 'completed', 'no_show', 'canceled', 'rescheduled',
    'pending_card'
  ));
