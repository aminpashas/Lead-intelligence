-- Case Closing Link
-- Connects the clinical case pipeline to the post-close treatment closing engine,
-- adds post-close case stages, surgery appointments, lab orders, and pre-op forms.

-- ============================================
-- 1. Link treatment_closings ↔ clinical_cases
-- ============================================
ALTER TABLE public.treatment_closings
  ADD COLUMN IF NOT EXISTS clinical_case_id uuid REFERENCES public.clinical_cases(id) ON DELETE SET NULL;

-- Cases can exist without a lead (walk-ins, referrals) — a closing must still be creatable
ALTER TABLE public.treatment_closings ALTER COLUMN lead_id DROP NOT NULL;

-- One active closing per case (UNIQUE(lead_id) already guards the lead path; NULLs are exempt)
CREATE UNIQUE INDEX IF NOT EXISTS idx_treatment_closings_case
  ON public.treatment_closings(clinical_case_id) WHERE clinical_case_id IS NOT NULL;

-- Backfill: attach each existing closing to the lead's most recent case
UPDATE public.treatment_closings tc
SET clinical_case_id = cc.id
FROM (
  SELECT DISTINCT ON (lead_id) id, lead_id
  FROM public.clinical_cases
  WHERE lead_id IS NOT NULL
  ORDER BY lead_id, created_at DESC
) cc
WHERE tc.clinical_case_id IS NULL
  AND cc.lead_id = tc.lead_id;

-- ============================================
-- 2. Post-close case stages
--    intake → analysis → diagnosis → treatment_planning → patient_review
--    → accepted → closing → surgery_scheduled → ready_for_surgery → completed
-- ============================================
ALTER TABLE public.clinical_cases DROP CONSTRAINT IF EXISTS clinical_cases_status_check;
ALTER TABLE public.clinical_cases ADD CONSTRAINT clinical_cases_status_check CHECK (status IN (
  'intake', 'analysis', 'diagnosis', 'treatment_planning', 'patient_review',
  'accepted', 'closing', 'surgery_scheduled', 'ready_for_surgery',
  'completed', 'archived'
));

-- ============================================
-- 3. Surgery appointment type
-- ============================================
ALTER TABLE public.appointments DROP CONSTRAINT IF EXISTS appointments_type_check;
ALTER TABLE public.appointments ADD CONSTRAINT appointments_type_check CHECK (type IN (
  'consultation', 'follow_up', 'treatment', 'scan', 'surgery', 'other'
));

-- ============================================
-- 4. Lab orders (records → external lab, e.g. Smile Design Lab)
-- ============================================
CREATE TABLE IF NOT EXISTS public.lab_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  clinical_case_id uuid NOT NULL REFERENCES public.clinical_cases(id) ON DELETE CASCADE,
  treatment_closing_id uuid REFERENCES public.treatment_closings(id) ON DELETE SET NULL,

  lab_provider text NOT NULL DEFAULT 'smile_design_lab'
    CHECK (lab_provider IN ('smile_design_lab', 'manual', 'other')),

  -- External lab reference (SDL case id / SDL-2026-XXXXXX number)
  external_case_id text,
  external_case_number text,

  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'submitted', 'accepted', 'declined', 'design_review',
    'manufacturing', 'shipped', 'delivered', 'completed', 'cancelled', 'error'
  )),

  -- What was ordered / sent
  items jsonb NOT NULL DEFAULT '[]',        -- [{ kind, description }] e.g. surgical guide, abutments
  files_sent jsonb NOT NULL DEFAULT '[]',   -- [{ case_file_id, file_name, file_type, sent_at }]
  tracking jsonb NOT NULL DEFAULT '{}',     -- { carrier, tracking_number, eta }
  status_history jsonb NOT NULL DEFAULT '[]', -- [{ from, to, at }]

  error text,
  submitted_at timestamptz,
  submitted_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lab_orders_org ON public.lab_orders(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_lab_orders_case ON public.lab_orders(clinical_case_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lab_orders_external
  ON public.lab_orders(lab_provider, external_case_id) WHERE external_case_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_lab_orders_updated_at ON public.lab_orders;
CREATE TRIGGER set_lab_orders_updated_at
  BEFORE UPDATE ON public.lab_orders
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.lab_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members can view lab orders"
  ON public.lab_orders FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.user_profiles WHERE id = auth.uid()));

CREATE POLICY "Org members can manage lab orders"
  ON public.lab_orders FOR ALL
  USING (organization_id IN (SELECT organization_id FROM public.user_profiles WHERE id = auth.uid()));

-- ============================================
-- 5. Pre-op instruction forms (share-token portal, mirrors contracts pattern)
-- ============================================
CREATE TABLE IF NOT EXISTS public.preop_forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  clinical_case_id uuid NOT NULL REFERENCES public.clinical_cases(id) ON DELETE CASCADE,
  treatment_closing_id uuid REFERENCES public.treatment_closings(id) ON DELETE SET NULL,

  title text NOT NULL DEFAULT 'Pre-Operative Instructions',
  rendered_html text NOT NULL,
  content jsonb NOT NULL DEFAULT '{}',      -- structured sections used to render

  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'viewed', 'acknowledged', 'voided')),

  share_token uuid NOT NULL DEFAULT gen_random_uuid(),
  share_token_expires_at timestamptz DEFAULT (now() + interval '60 days'),

  sent_via text CHECK (sent_via IN ('sms', 'email', 'both')),
  sent_at timestamptz,
  first_viewed_at timestamptz,
  acknowledged_at timestamptz,
  acknowledged_name text,

  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_preop_forms_org ON public.preop_forms(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_preop_forms_case ON public.preop_forms(clinical_case_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_preop_forms_share_token ON public.preop_forms(share_token);

DROP TRIGGER IF EXISTS set_preop_forms_updated_at ON public.preop_forms;
CREATE TRIGGER set_preop_forms_updated_at
  BEFORE UPDATE ON public.preop_forms
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.preop_forms ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members can view preop forms"
  ON public.preop_forms FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.user_profiles WHERE id = auth.uid()));

CREATE POLICY "Org members can manage preop forms"
  ON public.preop_forms FOR ALL
  USING (organization_id IN (SELECT organization_id FROM public.user_profiles WHERE id = auth.uid()));
