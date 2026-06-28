-- ════════════════════════════════════════════════════════════════
-- Migration 010: AI Conversation Ratings (Admin Audit)
-- Allows admins to rate and flag AI conversation quality
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ai_conversation_ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  rated_by uuid NOT NULL REFERENCES user_profiles(id),

  rating integer NOT NULL CHECK (rating >= 1 AND rating <= 5),
  notes text,
  flagged boolean DEFAULT false,

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- One rating per conversation per user
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_ratings_conv_user
  ON ai_conversation_ratings(conversation_id, rated_by);

CREATE INDEX IF NOT EXISTS idx_ai_ratings_org
  ON ai_conversation_ratings(organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_ratings_flagged
  ON ai_conversation_ratings(organization_id, flagged) WHERE flagged = true;

-- RLS
ALTER TABLE ai_conversation_ratings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_ratings_org_isolation" ON ai_conversation_ratings
  FOR ALL USING (organization_id = public.get_user_org_id());
