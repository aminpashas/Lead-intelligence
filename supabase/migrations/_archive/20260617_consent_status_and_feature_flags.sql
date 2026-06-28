-- ═══════════════════════════════════════════════════════════════
-- Phase 0/1.1 — Consent state model + org feature flags
-- ═══════════════════════════════════════════════════════════════
-- Problem: bridged DGS/GHL leads land with sms_consent=false (column DEFAULT),
-- which is indistinguishable from "lead explicitly declined". That silently
-- zeroes our addressable population and makes a consent-capture flow impossible
-- to target.
--
-- Fix: add an ADDITIVE tri-state status column per channel —
--   'granted'  = explicit opt-in (boolean consent = true)
--   'declined' = explicit opt-out OR explicit "no" at capture time
--   'unknown'  = never asked / no signal  ← the segment we can solicit for consent
--
-- The boolean *_consent / *_opt_out columns remain the source of truth for the
-- consent GATE (src/lib/consent/gate.ts is unchanged in behavior). The status
-- column is for routing, UX, and the "needs consent" segment only.

-- ──────────────────────────────────────────────────────────────
-- 1. Status columns on leads
-- ──────────────────────────────────────────────────────────────
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS sms_consent_status text NOT NULL DEFAULT 'unknown'
    CHECK (sms_consent_status IN ('granted', 'declined', 'unknown')),
  ADD COLUMN IF NOT EXISTS email_consent_status text NOT NULL DEFAULT 'unknown'
    CHECK (email_consent_status IN ('granted', 'declined', 'unknown')),
  ADD COLUMN IF NOT EXISTS voice_consent_status text NOT NULL DEFAULT 'unknown'
    CHECK (voice_consent_status IN ('granted', 'declined', 'unknown'));

COMMENT ON COLUMN public.leads.sms_consent_status IS 'Tri-state derived from sms_consent/sms_opt_out + explicit ingest signal: granted | declined | unknown. unknown = eligible for consent-capture flow.';
COMMENT ON COLUMN public.leads.email_consent_status IS 'Tri-state email consent: granted | declined | unknown.';
COMMENT ON COLUMN public.leads.voice_consent_status IS 'Tri-state voice consent: granted | declined | unknown (declined also when do_not_call).';

-- ──────────────────────────────────────────────────────────────
-- 2. Backfill from current boolean state
-- ──────────────────────────────────────────────────────────────
UPDATE public.leads SET
  sms_consent_status = CASE
    WHEN COALESCE(sms_opt_out, false) THEN 'declined'
    WHEN COALESCE(sms_consent, false) THEN 'granted'
    ELSE 'unknown' END,
  email_consent_status = CASE
    WHEN COALESCE(email_opt_out, false) THEN 'declined'
    WHEN COALESCE(email_consent, false) THEN 'granted'
    ELSE 'unknown' END,
  voice_consent_status = CASE
    WHEN COALESCE(do_not_call, false) OR COALESCE(voice_opt_out, false) THEN 'declined'
    WHEN COALESCE(voice_consent, false) THEN 'granted'
    ELSE 'unknown' END;

-- "Needs consent" segment lookups (the consent-capture cron/queue targets these).
CREATE INDEX IF NOT EXISTS idx_leads_sms_consent_unknown
  ON public.leads(organization_id) WHERE sms_consent_status = 'unknown';

-- ──────────────────────────────────────────────────────────────
-- 3. Keep status consistent with the booleans (BEFORE trigger)
--    Handles the inbound STOP/START + campaign code paths that only flip
--    booleans, without them needing to know about the status column.
--    Invariant: opt-out/DNC ⇒ declined; boolean grant ⇒ granted; otherwise
--    preserve whatever was written (so an explicit 'declined' at ingest, where
--    the boolean stays false, is not reset to 'unknown').
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sync_consent_status()
RETURNS trigger AS $$
BEGIN
  IF NEW.sms_opt_out IS TRUE THEN
    NEW.sms_consent_status := 'declined';
  ELSIF NEW.sms_consent IS TRUE THEN
    NEW.sms_consent_status := 'granted';
  ELSIF NEW.sms_consent_status IS NULL THEN
    NEW.sms_consent_status := 'unknown';
  END IF;

  IF NEW.email_opt_out IS TRUE THEN
    NEW.email_consent_status := 'declined';
  ELSIF NEW.email_consent IS TRUE THEN
    NEW.email_consent_status := 'granted';
  ELSIF NEW.email_consent_status IS NULL THEN
    NEW.email_consent_status := 'unknown';
  END IF;

  IF NEW.do_not_call IS TRUE OR NEW.voice_opt_out IS TRUE THEN
    NEW.voice_consent_status := 'declined';
  ELSIF NEW.voice_consent IS TRUE THEN
    NEW.voice_consent_status := 'granted';
  ELSIF NEW.voice_consent_status IS NULL THEN
    NEW.voice_consent_status := 'unknown';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sync_lead_consent_status ON public.leads;
CREATE TRIGGER sync_lead_consent_status
  BEFORE INSERT OR UPDATE OF
    sms_consent, sms_opt_out, sms_consent_status,
    email_consent, email_opt_out, email_consent_status,
    voice_consent, voice_opt_out, do_not_call, voice_consent_status
  ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.sync_consent_status();

-- ──────────────────────────────────────────────────────────────
-- 4. Extend the consent_log audit trigger to cover VOICE
--    (023 only logged sms/email). Recreate the function with voice branches
--    and widen the AFTER trigger's column list.
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.log_consent_change()
RETURNS trigger AS $$
BEGIN
  -- SMS consent grant
  IF (tg_op = 'INSERT' AND new.sms_consent = true)
     OR (tg_op = 'UPDATE' AND coalesce(old.sms_consent, false) IS DISTINCT FROM new.sms_consent AND new.sms_consent = true) THEN
    INSERT INTO public.consent_log (organization_id, lead_id, channel, consent_given, granted_at, source, source_text)
    VALUES (new.organization_id, new.id, 'sms', true, coalesce(new.sms_consent_at, now()), new.sms_consent_source, null);
  END IF;

  -- SMS opt-out (revoke)
  IF (tg_op = 'UPDATE' AND coalesce(old.sms_opt_out, false) IS DISTINCT FROM new.sms_opt_out AND new.sms_opt_out = true) THEN
    INSERT INTO public.consent_log (organization_id, lead_id, channel, consent_given, revoked_at, source)
    VALUES (new.organization_id, new.id, 'sms', false, coalesce(new.sms_opt_out_at, now()), 'inbound_stop');
  END IF;

  -- Email consent grant
  IF (tg_op = 'INSERT' AND new.email_consent = true)
     OR (tg_op = 'UPDATE' AND coalesce(old.email_consent, false) IS DISTINCT FROM new.email_consent AND new.email_consent = true) THEN
    INSERT INTO public.consent_log (organization_id, lead_id, channel, consent_given, granted_at, source)
    VALUES (new.organization_id, new.id, 'email', true, coalesce(new.email_consent_at, now()), new.email_consent_source);
  END IF;

  -- Email opt-out (revoke)
  IF (tg_op = 'UPDATE' AND coalesce(old.email_opt_out, false) IS DISTINCT FROM new.email_opt_out AND new.email_opt_out = true) THEN
    INSERT INTO public.consent_log (organization_id, lead_id, channel, consent_given, revoked_at, source)
    VALUES (new.organization_id, new.id, 'email', false, coalesce(new.email_opt_out_at, now()), 'unsubscribe');
  END IF;

  -- Voice consent grant  (NEW)
  IF (tg_op = 'INSERT' AND new.voice_consent = true)
     OR (tg_op = 'UPDATE' AND coalesce(old.voice_consent, false) IS DISTINCT FROM new.voice_consent AND new.voice_consent = true) THEN
    INSERT INTO public.consent_log (organization_id, lead_id, channel, consent_given, granted_at, source)
    VALUES (new.organization_id, new.id, 'voice', true, coalesce(new.voice_consent_at, now()), new.voice_consent_source);
  END IF;

  -- Voice opt-out / DNC (revoke)  (NEW)
  IF (tg_op = 'UPDATE'
      AND (coalesce(old.voice_opt_out, false) IS DISTINCT FROM new.voice_opt_out AND new.voice_opt_out = true
           OR coalesce(old.do_not_call, false) IS DISTINCT FROM new.do_not_call AND new.do_not_call = true)) THEN
    INSERT INTO public.consent_log (organization_id, lead_id, channel, consent_given, revoked_at, source)
    VALUES (new.organization_id, new.id, 'voice', false, coalesce(new.voice_opt_out_at, now()),
            CASE WHEN new.do_not_call = true THEN 'do_not_call' ELSE 'inbound_stop' END);
  END IF;

  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS log_lead_consent_change ON public.leads;
CREATE TRIGGER log_lead_consent_change
  AFTER INSERT OR UPDATE OF
    sms_consent, sms_opt_out, email_consent, email_opt_out,
    voice_consent, voice_opt_out, do_not_call
  ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.log_consent_change();

-- ──────────────────────────────────────────────────────────────
-- 5. Org-level feature flags (dark-launch switchboard for this plan)
-- ──────────────────────────────────────────────────────────────
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS feature_flags jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.organizations.feature_flags IS 'Per-org dark-launch switchboard. Keys: consent_capture, us_sms_enabled, link_lender_tracking, lender_api_cherry, lender_api_alpheon, autonomous_reengagement, competitor_intel, org_goals, business_alerts. All default OFF (absent key = false).';
