-- ════════════════════════════════════════════════════════════════
-- Migration 033: Agent Performance Reviews + Current Status
--
-- Phase B: Accountability Engine. Weekly cron (see
-- /api/cron/agent-reviews) computes a per-agent review against the
-- KPI targets seeded in migration 030 and writes:
--   - agent_performance_reviews → audit trail of every review
--   - agent_status_current     → denormalized hot-path for badges
--
-- Grade math itself lives in src/lib/agents/grading.ts so the cron
-- and the UI never disagree on green/yellow/red.
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS agent_performance_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  kpi_scores jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- kpi_scores shape:
  --   { contact_rate: { value, target, status: 'pass'|'warning'|'critical' }, ... }
  overall_grade text NOT NULL CHECK (overall_grade IN ('green', 'yellow', 'red', 'probation')),
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- reasons: [{ kpi_name, severity: 'warning'|'critical', value, target }]
  notes text,
  reviewed_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  -- NULL when reviewed_by is the system cron; populated on manual override
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_agent_perf_reviews_agent_period
  ON agent_performance_reviews(agent_id, period_end DESC);

CREATE INDEX IF NOT EXISTS idx_agent_perf_reviews_org_grade
  ON agent_performance_reviews(organization_id, overall_grade, period_end DESC);

ALTER TABLE agent_performance_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_performance_reviews_org_isolation" ON agent_performance_reviews
  FOR ALL USING (organization_id = public.get_user_org_id());

-- ── Hot-path current status (denormalized) ──────────────────
-- One row per agent. Updated atomically by the same cron that
-- writes the review. UI badges read from here so they don't need
-- to scan history.
CREATE TABLE IF NOT EXISTS agent_status_current (
  agent_id uuid PRIMARY KEY REFERENCES ai_agents(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('green', 'yellow', 'red', 'probation', 'unrated')),
  since timestamptz NOT NULL DEFAULT now(),
  consecutive_red_periods integer NOT NULL DEFAULT 0,
  consecutive_green_periods integer NOT NULL DEFAULT 0,
  last_review_id uuid REFERENCES agent_performance_reviews(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_status_org_status
  ON agent_status_current(organization_id, status);

ALTER TABLE agent_status_current ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_status_current_org_isolation" ON agent_status_current
  FOR ALL USING (organization_id = public.get_user_org_id());

-- ── Seed an 'unrated' row for every existing agent ──────────
INSERT INTO agent_status_current (agent_id, organization_id, status, since)
SELECT a.id, a.organization_id, 'unrated', now()
  FROM ai_agents a
ON CONFLICT (agent_id) DO NOTHING;

-- ── Trigger: ensure new agents get a status row ─────────────
CREATE OR REPLACE FUNCTION public.seed_agent_status_current()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO agent_status_current (agent_id, organization_id, status)
  VALUES (NEW.id, NEW.organization_id, 'unrated')
  ON CONFLICT (agent_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_seed_agent_status_current ON ai_agents;
CREATE TRIGGER trg_seed_agent_status_current
  AFTER INSERT ON ai_agents
  FOR EACH ROW
  EXECUTE FUNCTION public.seed_agent_status_current();
