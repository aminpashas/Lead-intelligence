-- Migration 022b: Bridge migration — adds leads columns that later migrations depend on
-- but that may be missing on databases provisioned before migration 006/008 were applied.
--
-- Was applied directly to the prod Supabase project via MCP on 2026-04-21 because the
-- live DB was missing these columns even though their original migrations (006_consent_fields,
-- 008_pii_encryption) had been authored. Committing here so fresh `supabase db push` runs
-- pick this up before migration 023's consent trigger references the columns.
--
-- All ALTER + CREATE statements are idempotent (IF NOT EXISTS).

-- ── TCPA / CAN-SPAM consent state (originally in 006_consent_fields) ──
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS sms_consent boolean NOT NULL DEFAULT false;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS sms_consent_at timestamptz;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS sms_consent_source text;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS email_consent boolean NOT NULL DEFAULT false;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS email_consent_at timestamptz;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS email_consent_source text;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS sms_opt_out boolean NOT NULL DEFAULT false;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS sms_opt_out_at timestamptz;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS email_opt_out boolean NOT NULL DEFAULT false;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS email_opt_out_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_leads_sms_consent
  ON public.leads(organization_id, sms_consent)
  WHERE sms_consent = true AND sms_opt_out = false;
CREATE INDEX IF NOT EXISTS idx_leads_email_consent
  ON public.leads(organization_id, email_consent)
  WHERE email_consent = true AND email_opt_out = false;

-- ── Search hashes (originally in 008_pii_encryption) ──
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS email_hash text;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS phone_hash text;

CREATE INDEX IF NOT EXISTS idx_leads_email_hash
  ON public.leads(organization_id, email_hash) WHERE email_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_phone_hash
  ON public.leads(organization_id, phone_hash) WHERE phone_hash IS NOT NULL;

-- ── Geo / forensics ──
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS ip_address inet;
