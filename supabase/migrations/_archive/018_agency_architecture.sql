-- Migration 018: Agency Architecture
-- Adds agency_admin role, agency_settings table, and updates RLS
-- so agency admins can see/manage all organizations.

-- ============================================
-- 1. EXTEND ROLE CONSTRAINT
-- Allow agency_admin in user_profiles.role
-- ============================================
ALTER TABLE public.user_profiles
  DROP CONSTRAINT IF EXISTS user_profiles_role_check;

ALTER TABLE public.user_profiles
  ADD CONSTRAINT user_profiles_role_check
    CHECK (role IN ('agency_admin', 'owner', 'admin', 'manager', 'member'));

-- ============================================
-- 2. AGENCY SETTINGS TABLE
-- Stores global platform config (AI, messaging keys, persona)
-- Only agency_admin can read/write this.
-- ============================================
CREATE TABLE IF NOT EXISTS public.agency_settings (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  key             text UNIQUE NOT NULL,  -- e.g. 'ai_persona', 'ai_model', 'autopilot_defaults'
  value           jsonb NOT NULL DEFAULT '{}',
  description     text,
  updated_by      uuid REFERENCES auth.users(id),
  updated_at      timestamptz DEFAULT now(),
  created_at      timestamptz DEFAULT now()
);

ALTER TABLE public.agency_settings ENABLE ROW LEVEL SECURITY;

-- Only agency_admin can read or modify agency settings
CREATE POLICY "Agency admins can manage agency settings"
  ON public.agency_settings FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid() AND role = 'agency_admin'
    )
  );

-- ============================================
-- 3. UPDATE ORGANIZATIONS RLS
-- Agency admins can see and manage ALL organizations
-- ============================================

-- Drop existing restrictive policy
DROP POLICY IF EXISTS "Users can view their own organization" ON public.organizations;
DROP POLICY IF EXISTS "Owners can update their organization" ON public.organizations;

-- New policy: org members see their own org; agency_admin sees all
CREATE POLICY "Users can view their organization or agency admin sees all"
  ON public.organizations FOR SELECT
  USING (
    id IN (
      SELECT organization_id FROM public.user_profiles WHERE id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'agency_admin'
    )
  );

CREATE POLICY "Owners or agency admins can update organizations"
  ON public.organizations FOR UPDATE
  USING (
    id IN (
      SELECT organization_id FROM public.user_profiles WHERE id = auth.uid() AND role IN ('owner', 'admin')
    )
    OR EXISTS (
      SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'agency_admin'
    )
  );

-- Agency admin can insert new organizations (for onboarding new practices)
CREATE POLICY "Agency admins can create organizations"
  ON public.organizations FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'agency_admin'
    )
  );

-- ============================================
-- 4. HELPER FUNCTION — is_agency_admin()
-- ============================================
CREATE OR REPLACE FUNCTION public.is_agency_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = auth.uid() AND role = 'agency_admin'
  );
$$;

-- ============================================
-- 5. SEED DEFAULT AGENCY SETTINGS
-- ============================================
INSERT INTO public.agency_settings (key, value, description)
VALUES
  ('ai_persona', '{"name": "Aria", "tone": "warm", "style": "consultative"}', 'AI agent persona configuration'),
  ('ai_model', '{"provider": "anthropic", "model": "claude-3-5-sonnet-20241022", "max_tokens": 1024}', 'AI model selection'),
  ('autopilot_defaults', '{"enabled": false, "mode": "assist", "delay_minutes": 5}', 'Default autopilot settings for new practices'),
  ('platform', '{"name": "Lead Intelligence", "version": "2.0", "agency_level": true}', 'Platform metadata')
ON CONFLICT (key) DO NOTHING;

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.handle_agency_settings_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_agency_settings_updated_at ON public.agency_settings;
CREATE TRIGGER set_agency_settings_updated_at
  BEFORE UPDATE ON public.agency_settings
  FOR EACH ROW EXECUTE FUNCTION public.handle_agency_settings_updated_at();
