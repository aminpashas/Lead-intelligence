-- Migration 009: Financing Lender Integration
-- Adds tables for multi-lender financing with waterfall engine

-- ═══════════════════════════════════════════════════════════════
-- 1. Lender Configurations (per-org, stores encrypted credentials)
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.financing_lender_configs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lender_slug text NOT NULL CHECK (lender_slug IN ('carecredit', 'sunbit', 'proceed', 'lendingclub')),
  display_name text NOT NULL,
  is_active boolean DEFAULT false,
  priority_order int NOT NULL DEFAULT 0,
  credentials_encrypted text, -- AES-256-GCM encrypted JSON blob of API keys/secrets
  config jsonb DEFAULT '{}'::jsonb, -- non-secret settings (merchant IDs, promo codes, provider office codes)
  integration_type text NOT NULL DEFAULT 'link' CHECK (integration_type IN ('api', 'link', 'iframe')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (organization_id, lender_slug)
);

-- RLS
ALTER TABLE public.financing_lender_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "financing_lender_configs_select" ON public.financing_lender_configs
  FOR SELECT USING (organization_id = public.get_user_org_id());
CREATE POLICY "financing_lender_configs_insert" ON public.financing_lender_configs
  FOR INSERT WITH CHECK (organization_id = public.get_user_org_id());
CREATE POLICY "financing_lender_configs_update" ON public.financing_lender_configs
  FOR UPDATE USING (organization_id = public.get_user_org_id());
CREATE POLICY "financing_lender_configs_delete" ON public.financing_lender_configs
  FOR DELETE USING (organization_id = public.get_user_org_id());


-- ═══════════════════════════════════════════════════════════════
-- 2. Financing Applications (one per waterfall run)
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.financing_applications (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'approved', 'denied', 'error', 'expired')),

  -- Encrypted applicant PII (SSN, income, employer, DOB, full address)
  applicant_data_encrypted text NOT NULL,
  applicant_ssn_hash text, -- HMAC-SHA256 for dedup without decrypting

  -- Amounts
  requested_amount numeric(10,2),
  approved_lender_slug text,
  approved_amount numeric(10,2),
  approved_terms jsonb, -- { apr, term_months, monthly_payment, promo_period_months }

  -- Waterfall state
  current_waterfall_step int DEFAULT 0,
  waterfall_config jsonb NOT NULL, -- snapshot of lender order at submission time

  -- Consent tracking
  consent_given_at timestamptz NOT NULL,
  consent_ip_address text,

  -- Share token for public form access
  share_token text UNIQUE,

  -- Expiry
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  completed_at timestamptz,

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- RLS
ALTER TABLE public.financing_applications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "financing_applications_select" ON public.financing_applications
  FOR SELECT USING (organization_id = public.get_user_org_id());
CREATE POLICY "financing_applications_insert" ON public.financing_applications
  FOR INSERT WITH CHECK (organization_id = public.get_user_org_id());
CREATE POLICY "financing_applications_update" ON public.financing_applications
  FOR UPDATE USING (organization_id = public.get_user_org_id());
CREATE POLICY "financing_applications_delete" ON public.financing_applications
  FOR DELETE USING (organization_id = public.get_user_org_id());

-- Indexes
CREATE INDEX idx_financing_applications_org_lead ON public.financing_applications(organization_id, lead_id);
CREATE UNIQUE INDEX idx_financing_applications_share_token ON public.financing_applications(share_token) WHERE share_token IS NOT NULL;


-- ═══════════════════════════════════════════════════════════════
-- 3. Financing Submissions (one per lender attempt in a waterfall)
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.financing_submissions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  application_id uuid NOT NULL REFERENCES public.financing_applications(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  lender_slug text NOT NULL,
  waterfall_step int NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'approved', 'denied', 'error', 'timeout', 'link_sent')),

  -- External tracking
  external_application_id text,
  application_url text, -- for link-based lenders: the URL sent to patient

  -- Response (non-PII only)
  response_data jsonb, -- approval amount, terms, denial reason code
  error_message text,

  -- Timestamps
  submitted_at timestamptz,
  responded_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- RLS
ALTER TABLE public.financing_submissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "financing_submissions_select" ON public.financing_submissions
  FOR SELECT USING (organization_id = public.get_user_org_id());
CREATE POLICY "financing_submissions_insert" ON public.financing_submissions
  FOR INSERT WITH CHECK (organization_id = public.get_user_org_id());
CREATE POLICY "financing_submissions_update" ON public.financing_submissions
  FOR UPDATE USING (organization_id = public.get_user_org_id());
CREATE POLICY "financing_submissions_delete" ON public.financing_submissions
  FOR DELETE USING (organization_id = public.get_user_org_id());

-- Indexes
CREATE INDEX idx_financing_submissions_app_step ON public.financing_submissions(application_id, waterfall_step);
CREATE INDEX idx_financing_submissions_org_lead ON public.financing_submissions(organization_id, lead_id);


-- ═══════════════════════════════════════════════════════════════
-- 4. Add financing_application_id to leads
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS financing_application_id uuid REFERENCES public.financing_applications(id);

CREATE INDEX IF NOT EXISTS idx_leads_financing_application ON public.leads(financing_application_id) WHERE financing_application_id IS NOT NULL;


-- ═══════════════════════════════════════════════════════════════
-- 5. Seed default lender configs for existing orgs
-- ═══════════════════════════════════════════════════════════════

INSERT INTO public.financing_lender_configs (organization_id, lender_slug, display_name, priority_order, integration_type, config)
SELECT
  o.id,
  lender.slug,
  lender.display_name,
  lender.priority,
  lender.integration_type,
  lender.config
FROM public.organizations o
CROSS JOIN (
  VALUES
    ('carecredit', 'CareCredit', 1, 'api', '{"provider": "synchrony"}'::jsonb),
    ('sunbit', 'Sunbit', 2, 'api', '{"provider": "sunbit"}'::jsonb),
    ('proceed', 'Proceed Finance', 3, 'link', '{"provider": "proceed"}'::jsonb),
    ('lendingclub', 'LendingClub', 4, 'link', '{"provider": "lendingclub"}'::jsonb)
) AS lender(slug, display_name, priority, integration_type, config)
ON CONFLICT (organization_id, lender_slug) DO NOTHING;
