-- ═══════════════════════════════════════════════════════════════
-- Decouple the PUBLIC self-serve booking widget from AI/staff booking
-- ───────────────────────────────────────────────────────────────
-- Previously a single flag, booking_settings.is_enabled, gated everything:
-- the AI's check_availability/create_booking tools AND the public booking
-- page (/api/booking/[orgId]/slots + /book). That meant you could not turn on
-- AI booking during calls without also exposing a public self-serve page.
--
-- After this migration:
--   • is_enabled              → booking system available to AI + staff
--   • public_booking_enabled  → ADDITIONALLY expose the public widget
-- The public routes now require BOTH flags; the AI tools require only is_enabled.
--
-- Defaults to false so no org's public page turns on implicitly.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.booking_settings
  ADD COLUMN IF NOT EXISTS public_booking_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.booking_settings.public_booking_enabled IS
  'Gates the PUBLIC self-serve booking widget (/api/booking/[orgId]). Requires is_enabled too. Decoupled so AI/staff booking (is_enabled) can be on without exposing the public page.';
