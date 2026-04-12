-- Role Play Training Arena tables
-- Stores interactive role-play sessions and extracted training examples

-- ── Role Play Sessions ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_roleplay_sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT 'Untitled Session',
  user_role TEXT NOT NULL CHECK (user_role IN ('patient', 'treatment_coordinator')),
  agent_target TEXT NOT NULL CHECK (agent_target IN ('setter', 'closer')),
  scenario_id TEXT,
  scenario_description TEXT,
  patient_persona JSONB,
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived')),
  session_summary TEXT,
  extracted_example_count INTEGER NOT NULL DEFAULT 0,
  overall_rating INTEGER CHECK (overall_rating >= 1 AND overall_rating <= 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for listing sessions
CREATE INDEX IF NOT EXISTS idx_roleplay_sessions_org
  ON ai_roleplay_sessions(organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_roleplay_sessions_status
  ON ai_roleplay_sessions(organization_id, status);

-- ── Training Examples (extracted from role-play) ────────────────
CREATE TABLE IF NOT EXISTS ai_training_examples (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES ai_roleplay_sessions(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'general'
    CHECK (category IN ('ideal_response', 'objection_handling', 'rapport_building', 'closing_technique', 'patient_education', 'follow_up', 'general')),
  scenario_context TEXT NOT NULL,
  patient_message TEXT NOT NULL,
  ideal_response TEXT NOT NULL,
  coaching_notes TEXT,
  agent_target TEXT NOT NULL CHECK (agent_target IN ('setter', 'closer')),
  is_approved BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fetching approved/active examples for agent context
CREATE INDEX IF NOT EXISTS idx_training_examples_active
  ON ai_training_examples(organization_id, agent_target, is_active);

CREATE INDEX IF NOT EXISTS idx_training_examples_session
  ON ai_training_examples(session_id);

-- ── RLS Policies ────────────────────────────────────────────────
ALTER TABLE ai_roleplay_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_training_examples ENABLE ROW LEVEL SECURITY;

-- Sessions: org-scoped access
CREATE POLICY "Users can manage their org roleplay sessions"
  ON ai_roleplay_sessions
  FOR ALL
  USING (
    organization_id IN (
      SELECT organization_id FROM user_profiles WHERE id = auth.uid()
    )
  )
  WITH CHECK (
    organization_id IN (
      SELECT organization_id FROM user_profiles WHERE id = auth.uid()
    )
  );

-- Training examples: org-scoped access
CREATE POLICY "Users can manage their org training examples"
  ON ai_training_examples
  FOR ALL
  USING (
    organization_id IN (
      SELECT organization_id FROM user_profiles WHERE id = auth.uid()
    )
  )
  WITH CHECK (
    organization_id IN (
      SELECT organization_id FROM user_profiles WHERE id = auth.uid()
    )
  );

-- ── Updated-at trigger ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_roleplay_sessions_updated_at
  BEFORE UPDATE ON ai_roleplay_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_training_examples_updated_at
  BEFORE UPDATE ON ai_training_examples
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
