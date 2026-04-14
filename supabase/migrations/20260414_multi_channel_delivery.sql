-- ════════════════════════════════════════════════════════════════
-- Multi-Channel Delivery System
-- Enables AI agents to trigger cross-channel communications
-- (e.g., send SMS/email during a voice call)
-- ════════════════════════════════════════════════════════════════

-- ── Practice Content Assets ─────────────────────────────────
-- Stores reusable content that AI agents can send to leads:
-- testimonial videos, before/after photos, practice info, etc.

CREATE TABLE IF NOT EXISTS practice_content_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN (
    'testimonial_video',
    'before_after_photo',
    'practice_info',
    'appointment_details',
    'financing_info',
    'procedure_info'
  )),
  title TEXT NOT NULL,
  description TEXT,
  content JSONB NOT NULL DEFAULT '{}',
  -- content schema varies by type:
  -- testimonial_video:    { patient_name, procedure, quote, video_url, thumbnail_url }
  -- before_after_photo:   { patient_name, procedure, before_url, after_url, description }
  -- practice_info:        { address, city, state, zip, phone, hours, map_url, parking_notes }
  -- appointment_details:  { template, includes_directions }
  -- financing_info:       { summary, options[], apply_url }
  -- procedure_info:       { procedure_name, overview, duration, recovery, benefits[] }
  media_urls TEXT[] NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  tags TEXT[] NOT NULL DEFAULT '{}',
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_by UUID REFERENCES user_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Cross-Channel Delivery Tracking ─────────────────────────
-- Records every cross-channel message triggered by the AI agent.
-- Links the source conversation to the delivery message.

CREATE TABLE IF NOT EXISTS cross_channel_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  
  -- Channel routing
  triggered_by_channel TEXT NOT NULL,     -- channel the AI was on when it triggered this
  delivered_via_channel TEXT NOT NULL,     -- channel used to deliver the content
  
  -- Content reference
  content_type TEXT NOT NULL,             -- type of content delivered
  content_asset_id UUID REFERENCES practice_content_assets(id),
  message_id UUID REFERENCES messages(id), -- the actual message record created
  
  -- Delivery status
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'delivered', 'failed')),
  error_message TEXT,
  
  -- Agent context
  agent_type TEXT,                        -- which agent triggered this (setter/closer)
  tool_name TEXT,                         -- which tool was called
  
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Indexes ─────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_content_assets_org_type 
  ON practice_content_assets(organization_id, type) 
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_content_assets_org_tags 
  ON practice_content_assets USING GIN(tags) 
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_cross_channel_conversation 
  ON cross_channel_deliveries(conversation_id);

CREATE INDEX IF NOT EXISTS idx_cross_channel_lead 
  ON cross_channel_deliveries(lead_id);

CREATE INDEX IF NOT EXISTS idx_cross_channel_org_date 
  ON cross_channel_deliveries(organization_id, created_at DESC);

-- ── Row Level Security ──────────────────────────────────────

ALTER TABLE practice_content_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE cross_channel_deliveries ENABLE ROW LEVEL SECURITY;

-- Content assets: org members can read, admins can write
CREATE POLICY "org_members_read_content_assets" ON practice_content_assets
  FOR SELECT
  USING (organization_id IN (
    SELECT organization_id FROM user_profiles WHERE id = auth.uid()
  ));

CREATE POLICY "org_admins_manage_content_assets" ON practice_content_assets
  FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM user_profiles WHERE id = auth.uid() AND role IN ('owner', 'admin', 'manager')
  ));

-- Cross-channel deliveries: org members can read
CREATE POLICY "org_members_read_deliveries" ON cross_channel_deliveries
  FOR SELECT
  USING (organization_id IN (
    SELECT organization_id FROM user_profiles WHERE id = auth.uid()
  ));

-- Service role can insert deliveries (from AI agent webhooks)
CREATE POLICY "service_role_insert_deliveries" ON cross_channel_deliveries
  FOR INSERT
  WITH CHECK (true);

-- ── Updated-at trigger ──────────────────────────────────────

CREATE OR REPLACE FUNCTION update_content_assets_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_content_assets_updated_at
  BEFORE UPDATE ON practice_content_assets
  FOR EACH ROW
  EXECUTE FUNCTION update_content_assets_updated_at();

-- ── Increment usage count function ──────────────────────────

CREATE OR REPLACE FUNCTION increment_asset_usage(asset_id UUID)
RETURNS void AS $$
BEGIN
  UPDATE practice_content_assets 
  SET usage_count = usage_count + 1 
  WHERE id = asset_id;
END;
$$ LANGUAGE plpgsql;
