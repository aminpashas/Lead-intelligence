-- ═══════════════════════════════════════════════════════════════
-- Financial Qualification & Coaching System
-- ═══════════════════════════════════════════════════════════════
-- AI-driven soft pre-qualification, financing readiness detection,
-- and multi-source budget coaching.

-- ──────────────────────────────────────────────────────────────
-- 1. Extend leads table with financial qualification fields
-- ──────────────────────────────────────────────────────────────

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS financial_qualification_tier text DEFAULT 'tier_c'
    CHECK (financial_qualification_tier IN ('tier_a', 'tier_b', 'tier_c', 'tier_d')),
  ADD COLUMN IF NOT EXISTS financing_readiness_score integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS financial_signals jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS financing_link_sent_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS preferred_monthly_budget integer DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS has_hsa_fsa boolean DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS estimated_down_payment integer DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS financial_coaching_notes text DEFAULT NULL;

-- Documentation
COMMENT ON COLUMN leads.financial_qualification_tier IS 'AI-assigned tier: tier_a (ready), tier_b (warm), tier_c (cold), tier_d (barrier)';
COMMENT ON COLUMN leads.financing_readiness_score IS 'AI-calculated 0-100 score indicating when to send financing links';
COMMENT ON COLUMN leads.financial_signals IS 'JSON of financial signals extracted from conversations (insurance, budget, savings, barriers)';
COMMENT ON COLUMN leads.preferred_monthly_budget IS 'Monthly budget detected from conversation (e.g. "I can do around $200/mo")';
COMMENT ON COLUMN leads.has_hsa_fsa IS 'Whether lead mentioned having HSA/FSA pre-tax health savings';
COMMENT ON COLUMN leads.estimated_down_payment IS 'Down payment capacity detected from conversation';

-- ──────────────────────────────────────────────────────────────
-- 2. Index for financing-readiness-based queries
-- ──────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_leads_financing_readiness
  ON leads(organization_id, financing_readiness_score DESC)
  WHERE financing_readiness_score > 50;

CREATE INDEX IF NOT EXISTS idx_leads_financial_tier
  ON leads(organization_id, financial_qualification_tier)
  WHERE financial_qualification_tier IN ('tier_a', 'tier_b');
