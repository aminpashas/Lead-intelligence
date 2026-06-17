-- ═══════════════════════════════════════════════════════════════
-- Phase 1.2 — Consent-capture tokens (opt-in micro-flow)
-- ═══════════════════════════════════════════════════════════════
-- Most bridged leads arrive sms/email_consent_status = 'unknown'. This is the
-- compliant path to earn consent: a single-use, expiring token backs a hosted
-- opt-in page (/optin/<token>). Confirming the page flips the lead's consent
-- booleans → status 'granted' (via the sync_consent_status trigger) and the
-- consent_log audit trigger records the grant.

CREATE TABLE IF NOT EXISTS public.consent_capture_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  channels text[] NOT NULL DEFAULT ARRAY['sms', 'email'],
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'expired')),
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consent_tokens_lead ON public.consent_capture_tokens(lead_id, created_at DESC);

COMMENT ON TABLE public.consent_capture_tokens IS 'Single-use, expiring tokens backing the /optin consent-capture page. Confirming sets the channel consent booleans on the lead. Service role handles the public confirm path.';

ALTER TABLE public.consent_capture_tokens ENABLE ROW LEVEL SECURITY;

-- Staff may view + create tokens for leads in their org. The public confirm path
-- runs as service role (RLS-exempt), so no anon policy is needed.
CREATE POLICY "Users can view consent tokens in their org"
  ON public.consent_capture_tokens FOR SELECT
  USING (organization_id = public.get_user_org_id());

CREATE POLICY "Users can create consent tokens in their org"
  ON public.consent_capture_tokens FOR INSERT
  WITH CHECK (organization_id = public.get_user_org_id());
