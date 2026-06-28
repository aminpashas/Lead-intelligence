-- =====================================================================
-- Migration: Connector System Tables
-- Stores per-organization connector configurations and event audit logs
-- =====================================================================

-- connector_configs: Per-org settings for each external connector
CREATE TABLE IF NOT EXISTS connector_configs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connector_type TEXT NOT NULL CHECK (connector_type IN (
    'google_ads', 'meta_capi', 'ga4', 'outbound_webhook', 'slack', 'google_reviews', 'callrail'
  )),
  enabled BOOLEAN NOT NULL DEFAULT false,
  -- Encrypted credentials (API keys, tokens, secrets)
  credentials JSONB NOT NULL DEFAULT '{}',
  -- Non-sensitive settings (event subscriptions, display options)
  settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  -- One config per connector type per org
  UNIQUE (organization_id, connector_type)
);

-- connector_events: Audit log of all events dispatched to connectors
CREATE TABLE IF NOT EXISTS connector_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  connector_type TEXT NOT NULL,
  event_type TEXT NOT NULL,
  success BOOLEAN NOT NULL DEFAULT false,
  status_code INTEGER,
  error_message TEXT,
  response_id TEXT,
  dispatched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_connector_configs_org
  ON connector_configs(organization_id);

CREATE INDEX IF NOT EXISTS idx_connector_events_org_type
  ON connector_events(organization_id, connector_type);

CREATE INDEX IF NOT EXISTS idx_connector_events_lead
  ON connector_events(lead_id);

CREATE INDEX IF NOT EXISTS idx_connector_events_dispatched
  ON connector_events(dispatched_at DESC);

-- RLS policies (multi-tenant)
ALTER TABLE connector_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_events ENABLE ROW LEVEL SECURITY;

-- Users can only see/manage connectors for their own org
CREATE POLICY connector_configs_org_policy ON connector_configs
  USING (organization_id = get_user_org_id());

CREATE POLICY connector_events_org_policy ON connector_events
  USING (organization_id = get_user_org_id());

-- Service role bypass for API/webhooks
CREATE POLICY connector_configs_service ON connector_configs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY connector_events_service ON connector_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);
