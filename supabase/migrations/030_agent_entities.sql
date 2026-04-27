-- ════════════════════════════════════════════════════════════════
-- Migration 030: Agent Entities + KPI Targets + Message Attribution
--
-- Introduces first-class AI agent records (Setter + Closer per org),
-- per-agent KPI target thresholds, and backfills messages.agent_id
-- so historical AI messages attribute to the correct agent.
--
-- Phase A of the AI Agent KPI Dashboard system.
-- ════════════════════════════════════════════════════════════════

-- ── ai_agents: first-class agent records ────────────────────
CREATE TABLE IF NOT EXISTS ai_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('setter', 'closer')),
  persona_description text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (organization_id, role)
);

CREATE INDEX IF NOT EXISTS idx_ai_agents_org ON ai_agents(organization_id);
CREATE INDEX IF NOT EXISTS idx_ai_agents_org_role_active
  ON ai_agents(organization_id, role) WHERE is_active = true;

ALTER TABLE ai_agents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_agents_org_isolation" ON ai_agents
  FOR ALL USING (organization_id = public.get_user_org_id());

-- ── agent_kpi_targets: threshold config per agent/KPI ────────
CREATE TABLE IF NOT EXISTS agent_kpi_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kpi_name text NOT NULL,
  target_value numeric NOT NULL,
  warning_threshold numeric NOT NULL,
  critical_threshold numeric NOT NULL,
  direction text NOT NULL CHECK (direction IN ('higher_is_better', 'lower_is_better')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, kpi_name)
);

CREATE INDEX IF NOT EXISTS idx_agent_kpi_targets_agent ON agent_kpi_targets(agent_id);

ALTER TABLE agent_kpi_targets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_kpi_targets_org_isolation" ON agent_kpi_targets
  FOR ALL USING (organization_id = public.get_user_org_id());

-- ── messages.agent_id: per-message attribution ──────────────
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES ai_agents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_messages_agent_created
  ON messages(agent_id, created_at DESC) WHERE agent_id IS NOT NULL;

-- ── Seed agents + default targets per existing org ──────────
DO $$
DECLARE
  org_row RECORD;
  setter_id uuid;
  closer_id uuid;
BEGIN
  FOR org_row IN SELECT id FROM organizations LOOP
    -- Seed Setter
    INSERT INTO ai_agents (organization_id, name, role, persona_description)
    VALUES (
      org_row.id,
      'Default Setter',
      'setter',
      'Handles initial outreach, qualification, and consultation booking.'
    )
    ON CONFLICT (organization_id, role) DO NOTHING
    RETURNING id INTO setter_id;

    IF setter_id IS NULL THEN
      SELECT id INTO setter_id FROM ai_agents
       WHERE organization_id = org_row.id AND role = 'setter';
    END IF;

    -- Seed Closer
    INSERT INTO ai_agents (organization_id, name, role, persona_description)
    VALUES (
      org_row.id,
      'Default Closer',
      'closer',
      'Handles post-consultation treatment coordination, financing, and close.'
    )
    ON CONFLICT (organization_id, role) DO NOTHING
    RETURNING id INTO closer_id;

    IF closer_id IS NULL THEN
      SELECT id INTO closer_id FROM ai_agents
       WHERE organization_id = org_row.id AND role = 'closer';
    END IF;

    -- Seed default targets for both agents
    -- Format: (agent_id, kpi_name, target, warn, crit, direction)
    INSERT INTO agent_kpi_targets (agent_id, organization_id, kpi_name, target_value, warning_threshold, critical_threshold, direction)
    VALUES
      -- Setter targets
      (setter_id, org_row.id, 'contact_rate',         80, 70, 60, 'higher_is_better'),
      (setter_id, org_row.id, 'avg_call_rating',      4.0, 3.5, 3.0, 'higher_is_better'),
      (setter_id, org_row.id, 'booking_rate',         30, 22, 15, 'higher_is_better'),
      (setter_id, org_row.id, 'no_show_rate',         20, 25, 35, 'lower_is_better'),
      (setter_id, org_row.id, 'reschedule_rate',      15, 20, 30, 'lower_is_better'),
      (setter_id, org_row.id, 'qualification_rate',   50, 40, 30, 'higher_is_better'),
      (setter_id, org_row.id, 'follow_up_rate',       70, 55, 40, 'higher_is_better'),
      (setter_id, org_row.id, 'leads_went_cold_rate', 25, 30, 40, 'lower_is_better'),
      (setter_id, org_row.id, 'no_communication_rate',20, 25, 35, 'lower_is_better'),
      (setter_id, org_row.id, 'avg_response_minutes', 5, 10, 15, 'lower_is_better'),
      -- Closer targets (same KPIs, same defaults — can be tuned per-agent later)
      (closer_id, org_row.id, 'contact_rate',         80, 70, 60, 'higher_is_better'),
      (closer_id, org_row.id, 'avg_call_rating',      4.0, 3.5, 3.0, 'higher_is_better'),
      (closer_id, org_row.id, 'booking_rate',         30, 22, 15, 'higher_is_better'),
      (closer_id, org_row.id, 'no_show_rate',         20, 25, 35, 'lower_is_better'),
      (closer_id, org_row.id, 'reschedule_rate',      15, 20, 30, 'lower_is_better'),
      (closer_id, org_row.id, 'qualification_rate',   50, 40, 30, 'higher_is_better'),
      (closer_id, org_row.id, 'follow_up_rate',       70, 55, 40, 'higher_is_better'),
      (closer_id, org_row.id, 'leads_went_cold_rate', 25, 30, 40, 'lower_is_better'),
      (closer_id, org_row.id, 'no_communication_rate',20, 25, 35, 'lower_is_better'),
      (closer_id, org_row.id, 'avg_response_minutes', 5, 10, 15, 'lower_is_better')
    ON CONFLICT (agent_id, kpi_name) DO NOTHING;
  END LOOP;
END $$;

-- ── Backfill messages.agent_id from conversations.active_agent ─
-- NOTE: UPDATE...FROM ON clauses cannot reference the target table,
-- so conversations and ai_agents are joined to messages via WHERE.
UPDATE messages m
   SET agent_id = a.id
  FROM conversations c, ai_agents a
 WHERE m.conversation_id = c.id
   AND a.organization_id = m.organization_id
   AND a.role = c.active_agent
   AND m.sender_type = 'ai'
   AND m.agent_id IS NULL
   AND c.active_agent IN ('setter', 'closer');

-- ── Auto-seed agents for new orgs ───────────────────────────
-- Trigger fires after a new organization row is inserted; ensures
-- every org has the default Setter/Closer pair without requiring
-- application-level bootstrap logic.
CREATE OR REPLACE FUNCTION public.seed_default_agents_for_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  setter_id uuid;
  closer_id uuid;
BEGIN
  INSERT INTO ai_agents (organization_id, name, role, persona_description)
  VALUES (NEW.id, 'Default Setter', 'setter',
          'Handles initial outreach, qualification, and consultation booking.')
  RETURNING id INTO setter_id;

  INSERT INTO ai_agents (organization_id, name, role, persona_description)
  VALUES (NEW.id, 'Default Closer', 'closer',
          'Handles post-consultation treatment coordination, financing, and close.')
  RETURNING id INTO closer_id;

  INSERT INTO agent_kpi_targets (agent_id, organization_id, kpi_name, target_value, warning_threshold, critical_threshold, direction)
  VALUES
    (setter_id, NEW.id, 'contact_rate',         80, 70, 60, 'higher_is_better'),
    (setter_id, NEW.id, 'avg_call_rating',      4.0, 3.5, 3.0, 'higher_is_better'),
    (setter_id, NEW.id, 'booking_rate',         30, 22, 15, 'higher_is_better'),
    (setter_id, NEW.id, 'no_show_rate',         20, 25, 35, 'lower_is_better'),
    (setter_id, NEW.id, 'reschedule_rate',      15, 20, 30, 'lower_is_better'),
    (setter_id, NEW.id, 'qualification_rate',   50, 40, 30, 'higher_is_better'),
    (setter_id, NEW.id, 'follow_up_rate',       70, 55, 40, 'higher_is_better'),
    (setter_id, NEW.id, 'leads_went_cold_rate', 25, 30, 40, 'lower_is_better'),
    (setter_id, NEW.id, 'no_communication_rate',20, 25, 35, 'lower_is_better'),
    (setter_id, NEW.id, 'avg_response_minutes', 5, 10, 15, 'lower_is_better'),
    (closer_id, NEW.id, 'contact_rate',         80, 70, 60, 'higher_is_better'),
    (closer_id, NEW.id, 'avg_call_rating',      4.0, 3.5, 3.0, 'higher_is_better'),
    (closer_id, NEW.id, 'booking_rate',         30, 22, 15, 'higher_is_better'),
    (closer_id, NEW.id, 'no_show_rate',         20, 25, 35, 'lower_is_better'),
    (closer_id, NEW.id, 'reschedule_rate',      15, 20, 30, 'lower_is_better'),
    (closer_id, NEW.id, 'qualification_rate',   50, 40, 30, 'higher_is_better'),
    (closer_id, NEW.id, 'follow_up_rate',       70, 55, 40, 'higher_is_better'),
    (closer_id, NEW.id, 'leads_went_cold_rate', 25, 30, 40, 'lower_is_better'),
    (closer_id, NEW.id, 'no_communication_rate',20, 25, 35, 'lower_is_better'),
    (closer_id, NEW.id, 'avg_response_minutes', 5, 10, 15, 'lower_is_better');

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_seed_default_agents ON organizations;
CREATE TRIGGER trg_seed_default_agents
  AFTER INSERT ON organizations
  FOR EACH ROW
  EXECUTE FUNCTION public.seed_default_agents_for_org();
