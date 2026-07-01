-- ═══════════════════════════════════════════════════════════════
-- Lead credit range (discovery-captured qualification signal)
--
-- The AI setter now runs discovery-first: before it discusses any
-- pricing/financing it learns the patient's goal + a casual credit
-- bucket ("great / good / fair / rebuilding"). That bucket is stored
-- here so it (a) feeds AI lead scoring's Financial Readiness dimension
-- and (b) is filterable in the leads table.
--
-- Nullable + defaults to NULL ('unknown' is represented as NULL) so
-- existing leads are unaffected until a conversation captures it.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS credit_range text
    CHECK (credit_range IS NULL OR credit_range IN
      ('excellent', 'good', 'fair', 'rebuilding', 'unknown')),
  -- Free-text "when do they want to move" captured in conversation. Distinct from
  -- consultation_date/treatment_date (which only exist AFTER a booking) — this lets
  -- a stated intent ("sometime next month") satisfy the discovery gate pre-booking.
  ADD COLUMN IF NOT EXISTS timeline_note text;

COMMENT ON COLUMN leads.credit_range IS
  'Casual self-reported credit bucket captured during AI/staff discovery. Feeds lead scoring (financial readiness). NULL = not yet learned.';
COMMENT ON COLUMN leads.timeline_note IS
  'Free-text stated timeline captured during discovery (e.g. "wants to start next month"). Feeds the discovery-complete gate and urgency scoring.';

-- Filter/segment leads by credit bucket (Smart Lists, leads table filter).
CREATE INDEX IF NOT EXISTS idx_leads_credit_range
  ON leads (organization_id, credit_range)
  WHERE credit_range IS NOT NULL;
