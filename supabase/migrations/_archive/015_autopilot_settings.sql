-- Autopilot system: org settings + escalation queue
-- Enables fully autonomous AI sales engine

-- ═══════════════════════════════════════════════════════════
-- AUTOPILOT SETTINGS on organizations
-- ═══════════════════════════════════════════════════════════

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS autopilot_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS autopilot_confidence_threshold NUMERIC(3,2) DEFAULT 0.75;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS autopilot_mode TEXT DEFAULT 'full'
  CHECK (autopilot_mode IN ('full', 'review_first', 'review_closers'));
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS autopilot_response_delay_min INTEGER DEFAULT 30;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS autopilot_response_delay_max INTEGER DEFAULT 180;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS autopilot_max_messages_per_hour INTEGER DEFAULT 10;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS autopilot_active_hours_start INTEGER DEFAULT 8;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS autopilot_active_hours_end INTEGER DEFAULT 21;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS autopilot_stop_words TEXT[] DEFAULT ARRAY[
  'stop', 'unsubscribe', 'opt out', 'opt-out',
  'talk to a person', 'speak to someone', 'talk to a human',
  'real person', 'human please', 'cancel'
];
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS autopilot_paused BOOLEAN DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS autopilot_speed_to_lead BOOLEAN DEFAULT TRUE;

-- ═══════════════════════════════════════════════════════════
-- ESCALATIONS TABLE
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS escalations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  reason TEXT NOT NULL CHECK (reason IN (
    'low_confidence',
    'patient_requested_human',
    'stop_word_detected',
    'compliance_flag',
    'max_attempts_reached',
    'agent_failure',
    'sentiment_drop'
  )),
  ai_notes TEXT,
  ai_draft_response TEXT,
  ai_confidence NUMERIC(3,2),
  agent_type TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'resolved', 'dismissed')),
  claimed_by UUID REFERENCES user_profiles(id),
  claimed_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolution_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_escalations_org_status ON escalations(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_escalations_lead ON escalations(lead_id);

-- Enable RLS
ALTER TABLE escalations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their org escalations"
  ON escalations FOR SELECT
  USING (organization_id IN (
    SELECT organization_id FROM user_profiles WHERE id = auth.uid()
  ));

CREATE POLICY "Users can update their org escalations"
  ON escalations FOR UPDATE
  USING (organization_id IN (
    SELECT organization_id FROM user_profiles WHERE id = auth.uid()
  ));

-- ═══════════════════════════════════════════════════════════
-- HOURLY MESSAGE COUNTER (for anti-spam throttling)
-- ═══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION count_ai_messages_last_hour(
  p_conversation_id UUID
) RETURNS INTEGER AS $$
  SELECT COUNT(*)::INTEGER
  FROM messages
  WHERE conversation_id = p_conversation_id
    AND sender_type = 'ai'
    AND direction = 'outbound'
    AND created_at > NOW() - INTERVAL '1 hour';
$$ LANGUAGE sql STABLE SECURITY DEFINER;
