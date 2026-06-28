-- ════════════════════════════════════════════════════════════════
-- Migration 034: Agent Protocols + Lead Caps + Auto-Tune Safety Rail
--
-- Phase C: Adaptive Protocols (reward/discipline).
--
-- The discipline engine (src/lib/agents/discipline-engine.ts) reads
-- agent_status_current and writes:
--   - agent_lead_caps          → reward/discipline via lead allocation
--   - agent_protocol_changes   → audit trail of every protocol swap
--   - agent_protocols          → versioned prompts/templates/cadence
--
-- organizations.auto_tune_enabled is the master safety rail:
--   default false → engine logs proposed swaps but doesn't activate
--   true          → engine flips agent_protocols.is_active live
-- ════════════════════════════════════════════════════════════════

-- ── Versioned protocols per agent ────────────────────────────
CREATE TABLE IF NOT EXISTS agent_protocols (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  version integer NOT NULL,
  name text NOT NULL,
  -- prompt_override: nullable — when null, the resolver falls back
  -- to the hardcoded prompt in setter-agent.ts / closer-agent.ts.
  -- This lets us seed safe defaults without copying 200+ lines of
  -- TS into SQL.
  prompt_override text,
  outreach_templates jsonb NOT NULL DEFAULT '{}'::jsonb,
  cadence_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  channel_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT false,
  created_from text NOT NULL CHECK (created_from IN ('seed', 'manual', 'auto_tune', 'ab_test', 'rollback')),
  created_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (agent_id, version)
);

-- Exactly one active protocol per agent
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_protocols_one_active
  ON agent_protocols(agent_id) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_agent_protocols_agent_version
  ON agent_protocols(agent_id, version DESC);

ALTER TABLE agent_protocols ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_protocols_org_isolation" ON agent_protocols
  FOR ALL USING (organization_id = public.get_user_org_id());

-- ── Lead capacity / multiplier (reward/discipline lever) ────
CREATE TABLE IF NOT EXISTS agent_lead_caps (
  agent_id uuid PRIMARY KEY REFERENCES ai_agents(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  base_daily_cap integer NOT NULL DEFAULT 100,
  multiplier numeric(4,2) NOT NULL DEFAULT 1.00 CHECK (multiplier >= 0.10 AND multiplier <= 3.00),
  -- Effective cap = base_daily_cap * multiplier
  -- Discipline engine adjusts multiplier:
  --   green streak ≥ 2 weeks → +0.25 (capped at 2.0)
  --   red                    → 0.50 (probation forces this)
  --   yellow                 → no change
  autopilot_mode_override text CHECK (autopilot_mode_override IN ('auto', 'review_first', 'off')),
  -- Discipline engine sets this to 'review_first' on probation;
  -- speed-to-lead and auto-respond consult it before sending.
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_lead_caps_org
  ON agent_lead_caps(organization_id);

ALTER TABLE agent_lead_caps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_lead_caps_org_isolation" ON agent_lead_caps
  FOR ALL USING (organization_id = public.get_user_org_id());

-- Seed default cap row for every existing agent
INSERT INTO agent_lead_caps (agent_id, organization_id, base_daily_cap, multiplier)
SELECT id, organization_id, 100, 1.00 FROM ai_agents
ON CONFLICT (agent_id) DO NOTHING;

-- Trigger: new agent → cap row
CREATE OR REPLACE FUNCTION public.seed_agent_lead_caps()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO agent_lead_caps (agent_id, organization_id, base_daily_cap, multiplier)
  VALUES (NEW.id, NEW.organization_id, 100, 1.00)
  ON CONFLICT (agent_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_seed_agent_lead_caps ON ai_agents;
CREATE TRIGGER trg_seed_agent_lead_caps
  AFTER INSERT ON ai_agents
  FOR EACH ROW
  EXECUTE FUNCTION public.seed_agent_lead_caps();

-- ── Audit trail: every protocol/cap change ───────────────────
CREATE TABLE IF NOT EXISTS agent_protocol_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  change_type text NOT NULL CHECK (change_type IN (
    'protocol_swap',         -- is_active flipped between versions
    'cap_increase',          -- multiplier raised (reward)
    'cap_decrease',          -- multiplier lowered (discipline)
    'autopilot_throttle',    -- autopilot_mode_override changed
    'protocol_proposed'      -- engine wanted to swap but auto_tune_enabled=false
  )),
  triggered_by text NOT NULL CHECK (triggered_by IN ('auto_discipline', 'auto_reward', 'manual', 'ab_test', 'rollback')),
  from_protocol_id uuid REFERENCES agent_protocols(id) ON DELETE SET NULL,
  to_protocol_id uuid REFERENCES agent_protocols(id) ON DELETE SET NULL,
  from_multiplier numeric(4,2),
  to_multiplier numeric(4,2),
  reason text NOT NULL,
  reference_review_id uuid REFERENCES agent_performance_reviews(id) ON DELETE SET NULL,
  created_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_protocol_changes_agent
  ON agent_protocol_changes(agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_protocol_changes_org_type
  ON agent_protocol_changes(organization_id, change_type, created_at DESC);

ALTER TABLE agent_protocol_changes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_protocol_changes_org_isolation" ON agent_protocol_changes
  FOR ALL USING (organization_id = public.get_user_org_id());

-- ── Master safety rail on organizations ─────────────────────
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS auto_tune_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN organizations.auto_tune_enabled IS
  'When true, the discipline engine will live-swap agent_protocols.is_active. When false (default), it only logs ''protocol_proposed'' rows so admins can review.';

-- ── Seed initial v1 protocol per agent (safe placeholder) ───
-- Stays inactive: the resolver falls back to the hardcoded TS
-- prompts when no active protocol exists, preserving today's
-- behavior. Gives a known v1 row to diff against when admins
-- create custom protocols.
DO $$
DECLARE
  agent_rec RECORD;
BEGIN
  FOR agent_rec IN
    SELECT id, organization_id, role FROM ai_agents
  LOOP
    INSERT INTO agent_protocols (
      agent_id, organization_id, version, name,
      prompt_override, outreach_templates, cadence_config, channel_rules,
      is_active, created_from
    )
    VALUES (
      agent_rec.id, agent_rec.organization_id, 1,
      'Default ' || initcap(agent_rec.role) || ' Protocol v1',
      NULL, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      false, 'seed'
    )
    ON CONFLICT (agent_id, version) DO NOTHING;
  END LOOP;
END $$;
