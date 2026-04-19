-- Migration 020: Practice Roles & RBAC
-- Adds healthcare-specific roles for Aurea Health practice management.
-- New roles: doctor_admin, doctor, nurse, assistant, treatment_coordinator, office_manager
-- Existing roles (agency_admin, owner, admin, manager, member) are preserved.

-- ============================================
-- 1. EXTEND ROLE CONSTRAINT
-- Add new healthcare-specific roles
-- ============================================
ALTER TABLE public.user_profiles
  DROP CONSTRAINT IF EXISTS user_profiles_role_check;

ALTER TABLE public.user_profiles
  ADD CONSTRAINT user_profiles_role_check
    CHECK (role IN (
      -- Agency-level
      'agency_admin',
      -- Legacy/generic roles (preserved for backward compat)
      'owner', 'admin', 'manager', 'member',
      -- Healthcare practice roles
      'doctor_admin',       -- Full admin doctor (practice owner)
      'doctor',             -- Clinical-only associate doctor
      'nurse',              -- Clinical + scheduling
      'assistant',          -- Clinical + scheduling
      'treatment_coordinator', -- Clinical + scheduling + campaigns
      'office_manager'      -- Full admin (non-doctor)
    ));

-- ============================================
-- 2. ADD PROFILE FIELDS FOR STAFF
-- ============================================
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS job_title text,
  ADD COLUMN IF NOT EXISTS specialty text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS invited_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS invited_at timestamptz;

COMMENT ON COLUMN public.user_profiles.job_title IS 'Display title, e.g. "Dr. Smith, DDS" or "RN"';
COMMENT ON COLUMN public.user_profiles.specialty IS 'Clinical specialty, e.g. "Implant Surgery", "Orthodontics"';
COMMENT ON COLUMN public.user_profiles.phone IS 'Staff contact phone number';
COMMENT ON COLUMN public.user_profiles.invited_by IS 'UUID of the user who invited this team member';
COMMENT ON COLUMN public.user_profiles.invited_at IS 'Timestamp when the invite was sent';

-- ============================================
-- 3. PERMISSION HELPER FUNCTIONS
-- ============================================

-- is_admin_role() — can manage billing, team, and full platform
CREATE OR REPLACE FUNCTION public.is_admin_role()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = auth.uid()
      AND role IN ('doctor_admin', 'office_manager', 'owner', 'admin', 'agency_admin')
  );
$$;

-- is_clinical_role() — has access to clinical features
CREATE OR REPLACE FUNCTION public.is_clinical_role()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = auth.uid()
      AND role IN (
        'doctor_admin', 'doctor', 'nurse', 'assistant',
        'treatment_coordinator', 'office_manager',
        'owner', 'admin', 'manager', 'member'
      )
  );
$$;

-- can_manage_team() — can invite/edit/deactivate team members
CREATE OR REPLACE FUNCTION public.can_manage_team()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = auth.uid()
      AND role IN ('doctor_admin', 'office_manager', 'owner', 'admin', 'agency_admin')
  );
$$;

-- can_view_billing() — can see billing, revenue, analytics
CREATE OR REPLACE FUNCTION public.can_view_billing()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = auth.uid()
      AND role IN ('doctor_admin', 'office_manager', 'owner', 'admin', 'agency_admin')
  );
$$;

-- ============================================
-- 4. UPDATE RLS FOR TEAM MANAGEMENT
-- Allow admin roles to insert new user profiles for their org
-- ============================================
DROP POLICY IF EXISTS "Admins can manage user profiles" ON public.user_profiles;

CREATE POLICY "Admins can manage user profiles"
  ON public.user_profiles FOR ALL
  USING (
    organization_id IN (
      SELECT organization_id FROM public.user_profiles
      WHERE id = auth.uid()
        AND role IN ('doctor_admin', 'office_manager', 'owner', 'admin', 'agency_admin')
    )
  );
