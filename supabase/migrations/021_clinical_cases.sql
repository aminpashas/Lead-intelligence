-- Migration 021: Clinical Cases Workflow
-- Implements the full case pipeline: intake → analysis → diagnosis → treatment_planning → patient_review → completed
-- Staff creates cases with file uploads, AI analyzes, doctor diagnoses, patient receives the plan.

-- ============================================
-- 1. CLINICAL CASES (master case record)
-- ============================================
CREATE TABLE IF NOT EXISTS public.clinical_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,

  -- Patient info (denormalized for display when lead is absent)
  patient_name text NOT NULL,
  patient_email text,
  patient_phone text,

  -- Case details
  case_number text NOT NULL,
  chief_complaint text NOT NULL,
  clinical_notes text,
  status text NOT NULL DEFAULT 'intake'
    CHECK (status IN ('intake', 'analysis', 'diagnosis', 'treatment_planning', 'patient_review', 'completed', 'archived')),
  priority text DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),

  -- Assignments
  created_by uuid NOT NULL REFERENCES auth.users(id),
  assigned_doctor_id uuid REFERENCES auth.users(id),

  -- AI analysis
  ai_analysis_summary jsonb,
  ai_analyzed_at timestamptz,

  -- Patient delivery
  share_token uuid DEFAULT gen_random_uuid(),
  patient_notified_at timestamptz,
  patient_viewed_at timestamptz,
  patient_accepted_at timestamptz,

  -- Timestamps
  diagnosed_at timestamptz,
  treatment_planned_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Auto-generate case number
CREATE OR REPLACE FUNCTION public.generate_case_number()
RETURNS trigger AS $$
DECLARE
  next_num integer;
BEGIN
  SELECT COALESCE(MAX(CAST(SUBSTRING(case_number FROM 'CASE-(\d+)') AS integer)), 0) + 1
  INTO next_num
  FROM public.clinical_cases
  WHERE organization_id = NEW.organization_id;

  NEW.case_number := 'CASE-' || LPAD(next_num::text, 5, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_case_number ON public.clinical_cases;
CREATE TRIGGER set_case_number
  BEFORE INSERT ON public.clinical_cases
  FOR EACH ROW
  WHEN (NEW.case_number IS NULL OR NEW.case_number = '')
  EXECUTE FUNCTION public.generate_case_number();

-- Updated at trigger
DROP TRIGGER IF EXISTS set_clinical_cases_updated_at ON public.clinical_cases;
CREATE TRIGGER set_clinical_cases_updated_at
  BEFORE UPDATE ON public.clinical_cases
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- Indexes
CREATE INDEX IF NOT EXISTS idx_clinical_cases_org_status ON public.clinical_cases(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_clinical_cases_assigned ON public.clinical_cases(assigned_doctor_id) WHERE assigned_doctor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clinical_cases_lead ON public.clinical_cases(lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clinical_cases_share_token ON public.clinical_cases(share_token);

-- ============================================
-- 2. CASE FILES (photos, x-rays, STL, CT)
-- ============================================
CREATE TABLE IF NOT EXISTS public.case_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.clinical_cases(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- File info
  file_name text NOT NULL,
  file_url text NOT NULL,
  file_size bigint,
  mime_type text,
  file_type text NOT NULL DEFAULT 'photo'
    CHECK (file_type IN ('photo', 'xray', 'panoramic', 'periapical', 'cephalometric', 'cbct', 'ct_scan', 'stl', 'intraoral', 'extraoral', 'other')),

  -- AI analysis results
  ai_analysis jsonb,
  ai_analyzed_at timestamptz,
  ai_confidence numeric(3,2),

  -- Metadata
  description text,
  sort_order integer DEFAULT 0,
  uploaded_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_case_files_case ON public.case_files(case_id);

-- ============================================
-- 3. CASE DIAGNOSIS (doctor's findings)
-- ============================================
CREATE TABLE IF NOT EXISTS public.case_diagnosis (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.clinical_cases(id) ON DELETE CASCADE UNIQUE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- Diagnosis
  diagnosis_summary text NOT NULL,
  findings jsonb NOT NULL DEFAULT '[]',
  icd_codes text[] DEFAULT '{}',
  severity text DEFAULT 'moderate'
    CHECK (severity IN ('mild', 'moderate', 'severe', 'critical')),

  -- Clinical details
  bone_quality text,
  soft_tissue_status text,
  occlusion_notes text,
  risk_factors text[],

  -- Doctor info
  diagnosed_by uuid NOT NULL REFERENCES auth.users(id),
  diagnosed_at timestamptz NOT NULL DEFAULT now(),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS set_case_diagnosis_updated_at ON public.case_diagnosis;
CREATE TRIGGER set_case_diagnosis_updated_at
  BEFORE UPDATE ON public.case_diagnosis
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ============================================
-- 4. CASE TREATMENT PLAN
-- ============================================
CREATE TABLE IF NOT EXISTS public.case_treatment_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.clinical_cases(id) ON DELETE CASCADE UNIQUE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- Plan overview
  plan_summary text NOT NULL,
  total_estimated_cost numeric(10,2),
  estimated_duration text,
  phases integer DEFAULT 1,

  -- Plan items (procedures)
  items jsonb NOT NULL DEFAULT '[]',
  -- Each item: { procedure, description, tooth_numbers, phase, estimated_cost, cdt_code, notes }

  -- Alternatives
  alternative_options jsonb DEFAULT '[]',
  -- Each: { name, description, estimated_cost, pros, cons }

  -- Doctor info
  planned_by uuid NOT NULL REFERENCES auth.users(id),
  approved_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS set_treatment_plans_updated_at ON public.case_treatment_plans;
CREATE TRIGGER set_treatment_plans_updated_at
  BEFORE UPDATE ON public.case_treatment_plans
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ============================================
-- 5. RLS POLICIES
-- ============================================
ALTER TABLE public.clinical_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_diagnosis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_treatment_plans ENABLE ROW LEVEL SECURITY;

-- Clinical cases: org members can read, clinical staff can create
CREATE POLICY "Org members can view cases"
  ON public.clinical_cases FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.user_profiles WHERE id = auth.uid()));

CREATE POLICY "Clinical staff can manage cases"
  ON public.clinical_cases FOR ALL
  USING (organization_id IN (SELECT organization_id FROM public.user_profiles WHERE id = auth.uid()));

-- Case files: same org access
CREATE POLICY "Org members can view case files"
  ON public.case_files FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.user_profiles WHERE id = auth.uid()));

CREATE POLICY "Clinical staff can manage case files"
  ON public.case_files FOR ALL
  USING (organization_id IN (SELECT organization_id FROM public.user_profiles WHERE id = auth.uid()));

-- Diagnosis
CREATE POLICY "Org members can view diagnosis"
  ON public.case_diagnosis FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.user_profiles WHERE id = auth.uid()));

CREATE POLICY "Doctors can manage diagnosis"
  ON public.case_diagnosis FOR ALL
  USING (organization_id IN (SELECT organization_id FROM public.user_profiles WHERE id = auth.uid()));

-- Treatment plans
CREATE POLICY "Org members can view treatment plans"
  ON public.case_treatment_plans FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.user_profiles WHERE id = auth.uid()));

CREATE POLICY "Doctors can manage treatment plans"
  ON public.case_treatment_plans FOR ALL
  USING (organization_id IN (SELECT organization_id FROM public.user_profiles WHERE id = auth.uid()));

-- ============================================
-- 6. STORAGE BUCKET
-- ============================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('case-files', 'case-files', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Org members can upload case files"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'case-files'
    AND (storage.foldername(name))[1] IN (
      SELECT organization_id::text FROM public.user_profiles WHERE id = auth.uid()
    )
  );

CREATE POLICY "Org members can view case files"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'case-files'
    AND (storage.foldername(name))[1] IN (
      SELECT organization_id::text FROM public.user_profiles WHERE id = auth.uid()
    )
  );
