-- ═══════════════════════════════════════════════════════════════
-- Phone-First Booking Protocol (AOX no-show reduction)
--
-- Adds per-practice protocol config to booking_settings and
-- card-on-file / no-show-fee tracking to appointments.
--
-- Behaviour is OFF by default (require_call_before_booking = false,
-- no_show_fee_enabled = false) so existing orgs are unaffected until
-- a practice opts in from Settings → Booking protocol.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. booking_settings: protocol config ──────────────────────
ALTER TABLE booking_settings
  -- Gate: block/deter booking a consultation until a qualifying phone call is logged.
  ADD COLUMN IF NOT EXISTS require_call_before_booking boolean NOT NULL DEFAULT false,
  -- No-show fee: save a card at booking and auto-charge on no_show.
  ADD COLUMN IF NOT EXISTS no_show_fee_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS no_show_fee_cents integer NOT NULL DEFAULT 5000
    CHECK (no_show_fee_cents BETWEEN 0 AND 100000),
  -- Discovery-call assets.
  ADD COLUMN IF NOT EXISTS youtube_testimonial_url text,
  ADD COLUMN IF NOT EXISTS consult_price_range_text text,
  -- Optional per-practice override of the default discovery script (null → code default).
  ADD COLUMN IF NOT EXISTS discovery_script text;

-- ── 2. appointments: gate override + card-on-file + fee ────────
ALTER TABLE appointments
  -- Which path created this appointment (ai | staff | public).
  ADD COLUMN IF NOT EXISTS booked_via text
    CHECK (booked_via IS NULL OR booked_via IN ('ai', 'staff', 'public')),
  -- Soft-gate override audit (staff booked despite no qualifying call).
  ADD COLUMN IF NOT EXISTS call_gate_overridden boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS override_reason text,
  ADD COLUMN IF NOT EXISTS override_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  -- Card-on-file (Stripe SetupIntent result).
  ADD COLUMN IF NOT EXISTS card_on_file boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS stripe_payment_method_id text,
  -- No-show fee lifecycle.
  ADD COLUMN IF NOT EXISTS no_show_fee_status text NOT NULL DEFAULT 'none'
    CHECK (no_show_fee_status IN ('none', 'pending', 'charged', 'failed', 'waived')),
  ADD COLUMN IF NOT EXISTS no_show_fee_cents integer,
  ADD COLUMN IF NOT EXISTS no_show_fee_charged_at timestamptz,
  ADD COLUMN IF NOT EXISTS no_show_fee_payment_intent_id text;

-- Fast lookup of appointments still owed a fee charge (dashboards / retries).
CREATE INDEX IF NOT EXISTS idx_appointments_no_show_fee_status
  ON appointments (organization_id, no_show_fee_status)
  WHERE no_show_fee_status IN ('pending', 'failed');
