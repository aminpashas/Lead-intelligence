-- ============================================================================
-- Patient case share-link expiry
-- ============================================================================
-- /api/cases/patient/[shareToken] exposes PHI (patient name, diagnosis,
-- treatment plan, file URLs) to anyone holding the token, via the service-role
-- client (RLS bypassed). Unlike patient_contracts, the case share token never
-- expired — a leaked link (logs, referrer, forwarded email) stayed valid forever.
--
-- Add an expiry column. Default 30 days from creation for new shares; existing
-- rows get 30 days from now so they don't break immediately.
-- ============================================================================

alter table public.clinical_cases
  add column if not exists share_token_expires_at timestamptz;

-- Backfill existing shared cases with a 30-day window from now.
update public.clinical_cases
  set share_token_expires_at = now() + interval '30 days'
  where share_token is not null and share_token_expires_at is null;

-- New shares default to 30 days out.
alter table public.clinical_cases
  alter column share_token_expires_at set default (now() + interval '30 days');
