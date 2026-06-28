-- ═══════════════════════════════════════════════════════════════
-- Phase 5.1 — Org-level goals
-- ═══════════════════════════════════════════════════════════════
-- Agent-level KPIs exist, but there was no org-level target ("Q3 pipeline $2M").
-- This table holds those targets; the dashboard computes on-pace status with the
-- same green/yellow/red language as agent grading (src/lib/goals/pacing.ts).

CREATE TABLE IF NOT EXISTS public.org_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  metric text NOT NULL CHECK (metric IN ('pipeline_value', 'conversions', 'revenue', 'bookings', 'qualification_rate')),
  target_value numeric(14, 2) NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  label text,
  created_by uuid REFERENCES public.user_profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_org_goals_org_period
  ON public.org_goals(organization_id, period_end DESC);

COMMENT ON TABLE public.org_goals IS 'Org-level targets (pipeline/conversions/revenue/bookings/qualification_rate) for a period. Pacing computed in app (src/lib/goals/pacing.ts).';

ALTER TABLE public.org_goals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view org goals in their org"
  ON public.org_goals FOR SELECT USING (organization_id = public.get_user_org_id());
CREATE POLICY "Users can create org goals in their org"
  ON public.org_goals FOR INSERT WITH CHECK (organization_id = public.get_user_org_id());
CREATE POLICY "Users can update org goals in their org"
  ON public.org_goals FOR UPDATE USING (organization_id = public.get_user_org_id());
CREATE POLICY "Users can delete org goals in their org"
  ON public.org_goals FOR DELETE USING (organization_id = public.get_user_org_id());
