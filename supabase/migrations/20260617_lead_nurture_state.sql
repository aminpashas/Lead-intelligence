-- ═══════════════════════════════════════════════════════════════
-- Phase 3 — Autonomous re-engagement state
-- ═══════════════════════════════════════════════════════════════
-- The Closer's cold-lead re-close ladder already exists in code but nothing
-- fires it on a schedule. This table is the per-lead cursor the reengagement
-- cron advances: which ladder stage we're on and when the next touch is due.

CREATE TABLE IF NOT EXISTS public.lead_nurture_state (
  lead_id uuid PRIMARY KEY REFERENCES public.leads(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  current_stage text,
  attempts int NOT NULL DEFAULT 0,
  last_touch_at timestamptz,
  next_action_at timestamptz,
  paused boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Due-lookup for the hourly cron: active (not paused) cursors whose next touch is due.
CREATE INDEX IF NOT EXISTS idx_nurture_due
  ON public.lead_nurture_state(organization_id, next_action_at)
  WHERE paused = false;

COMMENT ON TABLE public.lead_nurture_state IS 'Per-lead re-engagement ladder cursor (Phase 3). Advanced by the reengagement cron; paused at graceful_release (handed to a human).';

ALTER TABLE public.lead_nurture_state ENABLE ROW LEVEL SECURITY;

-- Staff may view; the cron writes as service role (RLS-exempt).
CREATE POLICY "Users can view nurture state in their org"
  ON public.lead_nurture_state FOR SELECT
  USING (organization_id = public.get_user_org_id());
