-- Conversation analysis → filterable lead fields.
--
-- The conversation-analysis sweep cron (/api/cron/analyze-conversations) runs a
-- compact AI analysis over each lead's most recent conversation and persists the
-- result here so Smart Lists can segment on it (intent / sentiment / objection /
-- red flag). Values are constrained to the enums in src/lib/validators/smart-list.ts.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS conversation_intent text,
  ADD COLUMN IF NOT EXISTS conversation_sentiment text,
  ADD COLUMN IF NOT EXISTS primary_objection text,
  ADD COLUMN IF NOT EXISTS conversation_red_flag boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS conversation_analyzed_at timestamptz;

COMMENT ON COLUMN leads.conversation_intent IS
  'AI-derived intent from latest conversation: ready_to_book | considering | exploring | resistant | disengaged';
COMMENT ON COLUMN leads.conversation_sentiment IS
  'AI-derived sentiment from latest conversation: positive | neutral | mixed | negative';
COMMENT ON COLUMN leads.primary_objection IS
  'AI-derived primary objection: cost | financing | fear_anxiety | timing | trust | medical | logistics | spouse_approval | none | other';
COMMENT ON COLUMN leads.conversation_red_flag IS
  'True when the latest conversation analysis surfaced a red flag (complaint, legal/compliance risk, churn signal)';
COMMENT ON COLUMN leads.conversation_analyzed_at IS
  'When the conversation-analysis sweep last analyzed this lead (compared to newest message to decide re-analysis)';

-- Smart-list filters always scope by organization_id first; partial indexes keep
-- them cheap since most of the book will be NULL until the sweep touches a lead.
CREATE INDEX IF NOT EXISTS idx_leads_org_conversation_intent
  ON leads (organization_id, conversation_intent) WHERE conversation_intent IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_org_conversation_sentiment
  ON leads (organization_id, conversation_sentiment) WHERE conversation_sentiment IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_org_primary_objection
  ON leads (organization_id, primary_objection) WHERE primary_objection IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_org_conversation_red_flag
  ON leads (organization_id) WHERE conversation_red_flag = true;
