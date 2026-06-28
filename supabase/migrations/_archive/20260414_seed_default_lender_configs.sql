-- ============================================================
-- Financing Schema + Lender Config Seed
--
-- Creates all financing-related tables if they don't exist,
-- expands the lender slug constraint to include all 7 lenders,
-- then seeds active link-based configs for every org.
--
-- Safe to run multiple times (IF NOT EXISTS + ON CONFLICT DO NOTHING).
-- ============================================================


-- ── 1. financing_lender_configs ────────────────────────────────

CREATE TABLE IF NOT EXISTS public.financing_lender_configs (
  id                    uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id       uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lender_slug           text        NOT NULL,
  display_name          text        NOT NULL,
  is_active             boolean     DEFAULT false,
  priority_order        int         NOT NULL DEFAULT 0,
  credentials_encrypted text,
  config                jsonb       DEFAULT '{}'::jsonb,
  integration_type      text        NOT NULL DEFAULT 'link',
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now(),
  UNIQUE (organization_id, lender_slug)
);

-- Add CHECK constraint on lender_slug if it doesn't already cover all slugs.
-- We drop any existing constraint and recreate to cover all 7 lenders.
DO $$
BEGIN
  -- Drop old constraint (may not exist — ignore error)
  ALTER TABLE public.financing_lender_configs
    DROP CONSTRAINT IF EXISTS financing_lender_configs_lender_slug_check;

  -- Recreate with full list
  ALTER TABLE public.financing_lender_configs
    ADD CONSTRAINT financing_lender_configs_lender_slug_check
    CHECK (lender_slug IN ('carecredit','sunbit','affirm','cherry','alpheon','proceed','lendingclub'));

  -- Drop old integration_type constraint if it exists
  ALTER TABLE public.financing_lender_configs
    DROP CONSTRAINT IF EXISTS financing_lender_configs_integration_type_check;

  ALTER TABLE public.financing_lender_configs
    ADD CONSTRAINT financing_lender_configs_integration_type_check
    CHECK (integration_type IN ('api', 'link', 'iframe'));
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Constraint update skipped: %', SQLERRM;
END;
$$;

-- RLS
ALTER TABLE public.financing_lender_configs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  CREATE POLICY "financing_lender_configs_select" ON public.financing_lender_configs
    FOR SELECT USING (organization_id = public.get_user_org_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;

DO $$
BEGIN
  CREATE POLICY "financing_lender_configs_insert" ON public.financing_lender_configs
    FOR INSERT WITH CHECK (organization_id = public.get_user_org_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;

DO $$
BEGIN
  CREATE POLICY "financing_lender_configs_update" ON public.financing_lender_configs
    FOR UPDATE USING (organization_id = public.get_user_org_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;

DO $$
BEGIN
  CREATE POLICY "financing_lender_configs_delete" ON public.financing_lender_configs
    FOR DELETE USING (organization_id = public.get_user_org_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;


-- ── 2. financing_applications ──────────────────────────────────

CREATE TABLE IF NOT EXISTS public.financing_applications (
  id                      uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id         uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lead_id                 uuid        NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  status                  text        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','in_progress','approved','denied','error','expired')),
  applicant_data_encrypted text       NOT NULL DEFAULT '',
  applicant_ssn_hash      text,
  requested_amount        numeric(10,2),
  approved_lender_slug    text,
  approved_amount         numeric(10,2),
  approved_terms          jsonb,
  current_waterfall_step  int         DEFAULT 0,
  waterfall_config        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  consent_given_at        timestamptz NOT NULL DEFAULT now(),
  consent_ip_address      text,
  share_token             text        UNIQUE,
  expires_at              timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  completed_at            timestamptz,
  created_at              timestamptz DEFAULT now(),
  updated_at              timestamptz DEFAULT now()
);

ALTER TABLE public.financing_applications ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  CREATE POLICY "financing_applications_select" ON public.financing_applications
    FOR SELECT USING (organization_id = public.get_user_org_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;

DO $$
BEGIN
  CREATE POLICY "financing_applications_insert" ON public.financing_applications
    FOR INSERT WITH CHECK (organization_id = public.get_user_org_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;

DO $$
BEGIN
  CREATE POLICY "financing_applications_update" ON public.financing_applications
    FOR UPDATE USING (organization_id = public.get_user_org_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_financing_applications_org_lead
  ON public.financing_applications(organization_id, lead_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_financing_applications_share_token
  ON public.financing_applications(share_token) WHERE share_token IS NOT NULL;


-- ── 3. financing_submissions ───────────────────────────────────

CREATE TABLE IF NOT EXISTS public.financing_submissions (
  id                      uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id         uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  application_id          uuid        NOT NULL REFERENCES public.financing_applications(id) ON DELETE CASCADE,
  lead_id                 uuid        NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  lender_slug             text        NOT NULL,
  waterfall_step          int         NOT NULL,
  status                  text        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','submitted','approved','denied','error','timeout','link_sent')),
  external_application_id text,
  application_url         text,
  response_data           jsonb,
  error_message           text,
  submitted_at            timestamptz,
  responded_at            timestamptz,
  created_at              timestamptz DEFAULT now()
);

ALTER TABLE public.financing_submissions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  CREATE POLICY "financing_submissions_select" ON public.financing_submissions
    FOR SELECT USING (organization_id = public.get_user_org_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;

DO $$
BEGIN
  CREATE POLICY "financing_submissions_insert" ON public.financing_submissions
    FOR INSERT WITH CHECK (organization_id = public.get_user_org_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;

DO $$
BEGIN
  CREATE POLICY "financing_submissions_update" ON public.financing_submissions
    FOR UPDATE USING (organization_id = public.get_user_org_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_financing_submissions_app_step
  ON public.financing_submissions(application_id, waterfall_step);

CREATE INDEX IF NOT EXISTS idx_financing_submissions_org_lead
  ON public.financing_submissions(organization_id, lead_id);


-- ── 4. Add financing columns to leads (if missing) ─────────────

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS financing_application_id uuid REFERENCES public.financing_applications(id);

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS financing_approved         boolean DEFAULT false;

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS financing_amount           numeric(10,2);

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS financing_link_sent_at     timestamptz;

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS financing_readiness_score  int DEFAULT 0;

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS credit_tier                text;

CREATE INDEX IF NOT EXISTS idx_leads_financing_application
  ON public.leads(financing_application_id) WHERE financing_application_id IS NOT NULL;


-- ── 5. Seed active link-based configs for all orgs ─────────────
-- Sunbit, Cherry, and Proceed need ZERO API credentials.
-- They generate prefilled URLs and activate the waterfall immediately.

INSERT INTO public.financing_lender_configs
  (organization_id, lender_slug, display_name, integration_type, is_active, priority_order, config)
SELECT
  o.id,
  l.slug,
  l.display_name,
  'link',
  true,
  l.priority_order,
  l.config
FROM public.organizations o
CROSS JOIN (
  VALUES
    ('sunbit',  'Sunbit',          1, '{"application_url":"https://sunbit.com/apply","promo_months":6}'::jsonb),
    ('cherry',  'Cherry',          2, '{"application_url":"https://withcherry.com/apply","promo_months":12}'::jsonb),
    ('proceed', 'Proceed Finance', 3, '{"application_url":"https://www.proceedfinance.com/apply","max_amount":200000}'::jsonb)
) AS l(slug, display_name, priority_order, config)
ON CONFLICT (organization_id, lender_slug) DO UPDATE
  SET is_active      = true,
      display_name   = EXCLUDED.display_name,
      integration_type = 'link',
      config         = EXCLUDED.config,
      updated_at     = now();


-- ── Verification ───────────────────────────────────────────────
SELECT
  o.name          AS organization,
  flc.lender_slug,
  flc.display_name,
  flc.integration_type,
  flc.priority_order,
  flc.is_active
FROM public.financing_lender_configs flc
JOIN public.organizations o ON o.id = flc.organization_id
ORDER BY o.name, flc.priority_order;
