-- Lead hold: a dated pause on ALL outbound automation for one lead.
-- hold_until IS NULL  → not on hold. A hold is cleared (not just expired) by
-- task-sweep once the date passes, so every consumer checks the same simple
-- predicate: hold_until IS NULL OR hold_until < now().
--
-- Distinct from closing_follow_up_at (20260708130000), which only mutes the
-- /closing board for deliberating deals. This actually silences the dialer,
-- campaigns, and sequences, and works on a brand-new lead. Idempotent.
DO $$
BEGIN
  IF to_regclass('public.leads') IS NOT NULL THEN
    ALTER TABLE public.leads
      ADD COLUMN IF NOT EXISTS hold_until  timestamptz,
      ADD COLUMN IF NOT EXISTS hold_reason text,
      ADD COLUMN IF NOT EXISTS hold_set_by uuid REFERENCES auth.users(id),
      ADD COLUMN IF NOT EXISTS hold_set_at timestamptz;

    CREATE INDEX IF NOT EXISTS idx_leads_hold_until
      ON public.leads (organization_id, hold_until)
      WHERE hold_until IS NOT NULL;
  END IF;
END $$;
