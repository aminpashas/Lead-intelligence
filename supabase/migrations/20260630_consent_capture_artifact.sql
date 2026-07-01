-- ═══════════════════════════════════════════════════════════════
-- Consent-capture artifact — IP / user-agent / exact disclosure at confirm
-- ═══════════════════════════════════════════════════════════════
-- The hosted /optin confirmation is the TCPA/CAN-SPAM consent record. To make it
-- defensible we persist, at confirm time: the confirming IP, the user-agent, and
-- the EXACT disclosure text the patient saw (reconstructed server-side from the
-- token's channels + org name via optInDisclosureSentence, so it can't be forged
-- client-side). Additive + nullable; the consent grant itself still lives in the
-- leads.*_consent booleans + consent_log. Written best-effort by
-- /api/consent/confirm AFTER the grant, so a missing column never breaks opt-in.

ALTER TABLE public.consent_capture_tokens
  ADD COLUMN IF NOT EXISTS confirmed_ip text,
  ADD COLUMN IF NOT EXISTS confirmed_user_agent text,
  ADD COLUMN IF NOT EXISTS disclosure_text text;

COMMENT ON COLUMN public.consent_capture_tokens.confirmed_ip IS 'Client IP that confirmed the opt-in (x-forwarded-for / x-real-ip). Part of the TCPA consent artifact.';
COMMENT ON COLUMN public.consent_capture_tokens.confirmed_user_agent IS 'User-agent that confirmed the opt-in. Part of the consent artifact.';
COMMENT ON COLUMN public.consent_capture_tokens.disclosure_text IS 'Exact disclosure sentence shown on the /optin page at confirm time (verbatim consent record).';
