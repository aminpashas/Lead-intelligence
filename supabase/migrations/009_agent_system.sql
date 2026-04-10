-- ════════════════════════════════════════════════════════════════
-- Migration 009: Setter & Closer Agent System
-- Adds agent tracking to conversations and handoff audit trail
-- ════════════════════════════════════════════════════════════════

-- ── Add agent fields to conversations ───────────────────────
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS active_agent text DEFAULT 'setter'
    CHECK (active_agent IN ('setter', 'closer', 'none')),
  ADD COLUMN IF NOT EXISTS agent_assigned_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS agent_handoff_count integer DEFAULT 0;

-- ── Agent Handoffs (audit trail) ────────────────────────────
CREATE TABLE IF NOT EXISTS agent_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,

  from_agent text NOT NULL CHECK (from_agent IN ('setter', 'closer', 'none', 'manual')),
  to_agent text NOT NULL CHECK (to_agent IN ('setter', 'closer', 'none', 'manual')),
  trigger_reason text NOT NULL,  -- e.g. 'stage_transition', 'manual_override', 'ai_suggestion', 'lead_went_cold'

  context_snapshot jsonb NOT NULL DEFAULT '{}',  -- HandoffContextSnapshot transferred to receiving agent

  initiated_by text NOT NULL CHECK (initiated_by IN ('system', 'user', 'ai')),
  initiated_by_user_id uuid REFERENCES user_profiles(id),

  created_at timestamptz DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_agent_handoffs_conversation
  ON agent_handoffs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_agent_handoffs_lead
  ON agent_handoffs(lead_id);
CREATE INDEX IF NOT EXISTS idx_agent_handoffs_org_created
  ON agent_handoffs(organization_id, created_at DESC);

-- ── RLS ─────────────────────────────────────────────────────
ALTER TABLE agent_handoffs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_handoffs_org_isolation" ON agent_handoffs
  FOR ALL USING (organization_id = public.get_user_org_id());
