-- ═══════════════════════════════════════════════════════════════
-- AI Voice Calling System — Database Migration
-- Adds voice_calls, voice_campaigns tables and voice consent fields
-- ═══════════════════════════════════════════════════════════════

-- ── 1. Add voice consent fields to leads ──────────────────────
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS voice_consent boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS voice_consent_at timestamptz,
  ADD COLUMN IF NOT EXISTS voice_consent_source text,
  ADD COLUMN IF NOT EXISTS voice_opt_out boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS voice_opt_out_at timestamptz,
  ADD COLUMN IF NOT EXISTS do_not_call boolean DEFAULT false;

-- ── 2. Add 'voice' to conversation channel enum ──────────────
-- Extend the channel to support 'voice' in conversations & messages
-- (If using text column or enum, ensure 'voice' is allowed)
-- Supabase uses text columns for these, so no enum alteration needed

-- ── 3. Voice Settings on Organizations ───────────────────────
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS voice_enabled boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS voice_provider text DEFAULT 'retell',
  ADD COLUMN IF NOT EXISTS voice_retell_agent_id text,
  ADD COLUMN IF NOT EXISTS voice_retell_api_key_encrypted text,
  ADD COLUMN IF NOT EXISTS voice_greeting text DEFAULT 'Hi, this is the patient coordinator calling from {practice_name}. Is this {first_name}?',
  ADD COLUMN IF NOT EXISTS voice_voicemail_message text DEFAULT 'Hi {first_name}, this is {practice_name} calling about your recent inquiry. We would love to help you explore your options. Please call us back at your convenience.',
  ADD COLUMN IF NOT EXISTS voice_max_call_duration_seconds integer DEFAULT 600,
  ADD COLUMN IF NOT EXISTS voice_max_outbound_per_hour integer DEFAULT 20,
  ADD COLUMN IF NOT EXISTS voice_outbound_caller_id text,
  ADD COLUMN IF NOT EXISTS voice_recording_enabled boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS voice_two_party_consent_states text[] DEFAULT ARRAY[
    'CA','CT','DE','FL','IL','MD','MA','MI','MT','NV','NH','OR','PA','VT','WA','WI'
  ];

-- ── 4. Voice Calls Table ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS voice_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  
  -- Call metadata
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  status text NOT NULL DEFAULT 'initiated' CHECK (status IN (
    'initiated', 'ringing', 'in_progress', 'completed', 
    'no_answer', 'busy', 'failed', 'voicemail', 'canceled'
  )),
  
  -- External IDs
  retell_call_id text UNIQUE,
  twilio_call_sid text,
  
  -- Call details
  from_number text NOT NULL,
  to_number text NOT NULL,
  duration_seconds integer DEFAULT 0,
  started_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  
  -- AI Agent
  agent_type text CHECK (agent_type IN ('setter', 'closer', 'none')),
  ai_confidence_avg numeric(4,3),
  
  -- Recording & Transcript
  recording_url text,
  recording_duration_seconds integer,
  transcript jsonb DEFAULT '[]'::jsonb,
  transcript_summary text,
  
  -- Outcome
  outcome text CHECK (outcome IN (
    'appointment_booked', 'callback_requested', 'interested', 
    'not_interested', 'wrong_number', 'do_not_call',
    'voicemail_left', 'no_answer', 'technical_failure', 'transferred', NULL
  )),
  outcome_notes text,
  
  -- Campaign link (if part of outbound campaign)
  voice_campaign_id uuid,
  
  -- Compliance
  consent_verified boolean DEFAULT false,
  recording_disclosure_given boolean DEFAULT false,
  tcpa_compliant boolean DEFAULT true,
  
  -- Metadata
  metadata jsonb DEFAULT '{}'::jsonb,
  
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- ── 5. Voice Campaigns Table ─────────────────────────────────
CREATE TABLE IF NOT EXISTS voice_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  
  name text NOT NULL,
  description text,
  
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'scheduled', 'active', 'paused', 'completed', 'archived'
  )),
  
  -- Targeting
  smart_list_id uuid,
  target_criteria jsonb DEFAULT '{}'::jsonb,
  
  -- Schedule
  scheduled_start_at timestamptz,
  scheduled_end_at timestamptz,
  active_hours_start integer DEFAULT 9,
  active_hours_end integer DEFAULT 18,
  active_days text[] DEFAULT ARRAY['monday','tuesday','wednesday','thursday','friday'],
  timezone text DEFAULT 'America/New_York',
  
  -- Dialing config
  max_attempts_per_lead integer DEFAULT 3,
  retry_delay_hours integer DEFAULT 24,
  concurrent_calls integer DEFAULT 1,
  calls_per_hour integer DEFAULT 20,
  
  -- AI config
  agent_type text DEFAULT 'setter' CHECK (agent_type IN ('setter', 'closer')),
  custom_greeting text,
  custom_voicemail text,
  
  -- Stats
  total_leads integer DEFAULT 0,
  total_called integer DEFAULT 0,
  total_connected integer DEFAULT 0,
  total_appointments integer DEFAULT 0,
  total_voicemails integer DEFAULT 0,
  total_no_answer integer DEFAULT 0,
  total_do_not_call integer DEFAULT 0,
  avg_call_duration_seconds integer DEFAULT 0,
  
  -- Metadata
  metadata jsonb DEFAULT '{}'::jsonb,
  
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- ── 6. Voice Campaign Leads (Queue) ─────────────────────────
CREATE TABLE IF NOT EXISTS voice_campaign_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voice_campaign_id uuid NOT NULL REFERENCES voice_campaigns(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'calling', 'completed', 'skipped', 'failed', 'do_not_call'
  )),
  
  attempts integer DEFAULT 0,
  last_attempt_at timestamptz,
  last_call_id uuid REFERENCES voice_calls(id),
  outcome text,
  
  priority integer DEFAULT 0,
  scheduled_at timestamptz,
  
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  
  UNIQUE(voice_campaign_id, lead_id)
);

-- ── 7. Indexes ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_voice_calls_org ON voice_calls(organization_id);
CREATE INDEX IF NOT EXISTS idx_voice_calls_lead ON voice_calls(lead_id);
CREATE INDEX IF NOT EXISTS idx_voice_calls_conversation ON voice_calls(conversation_id);
CREATE INDEX IF NOT EXISTS idx_voice_calls_retell ON voice_calls(retell_call_id);
CREATE INDEX IF NOT EXISTS idx_voice_calls_status ON voice_calls(status);
CREATE INDEX IF NOT EXISTS idx_voice_calls_campaign ON voice_calls(voice_campaign_id);
CREATE INDEX IF NOT EXISTS idx_voice_calls_created ON voice_calls(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_voice_campaigns_org ON voice_campaigns(organization_id);
CREATE INDEX IF NOT EXISTS idx_voice_campaigns_status ON voice_campaigns(status);

CREATE INDEX IF NOT EXISTS idx_voice_campaign_leads_campaign ON voice_campaign_leads(voice_campaign_id);
CREATE INDEX IF NOT EXISTS idx_voice_campaign_leads_status ON voice_campaign_leads(status) WHERE status = 'queued';

-- ── 8. RLS Policies ──────────────────────────────────────────
ALTER TABLE voice_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_campaign_leads ENABLE ROW LEVEL SECURITY;

-- Voice Calls: users can only see calls in their organization
CREATE POLICY "voice_calls_org_isolation" ON voice_calls
  FOR ALL USING (
    organization_id IN (
      SELECT organization_id FROM user_profiles
      WHERE id = auth.uid()
    )
  );

-- Voice Campaigns: users can only see campaigns in their organization
CREATE POLICY "voice_campaigns_org_isolation" ON voice_campaigns
  FOR ALL USING (
    organization_id IN (
      SELECT organization_id FROM user_profiles
      WHERE id = auth.uid()
    )
  );

-- Voice Campaign Leads: users can only see queue in their organization
CREATE POLICY "voice_campaign_leads_org_isolation" ON voice_campaign_leads
  FOR ALL USING (
    organization_id IN (
      SELECT organization_id FROM user_profiles
      WHERE id = auth.uid()
    )
  );

-- Service role bypass for webhooks and cron
CREATE POLICY "voice_calls_service_role" ON voice_calls
  FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "voice_campaigns_service_role" ON voice_campaigns
  FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "voice_campaign_leads_service_role" ON voice_campaign_leads
  FOR ALL USING (auth.role() = 'service_role');

-- ── 9. Updated_at trigger ────────────────────────────────────
CREATE OR REPLACE FUNCTION update_voice_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER voice_calls_updated_at
  BEFORE UPDATE ON voice_calls
  FOR EACH ROW EXECUTE FUNCTION update_voice_updated_at();

CREATE TRIGGER voice_campaigns_updated_at
  BEFORE UPDATE ON voice_campaigns
  FOR EACH ROW EXECUTE FUNCTION update_voice_updated_at();

CREATE TRIGGER voice_campaign_leads_updated_at
  BEFORE UPDATE ON voice_campaign_leads
  FOR EACH ROW EXECUTE FUNCTION update_voice_updated_at();
