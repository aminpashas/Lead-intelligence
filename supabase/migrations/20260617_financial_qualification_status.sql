-- ═══════════════════════════════════════════════════════════════
-- Phase 2.1 — Financing-signal honesty
-- ═══════════════════════════════════════════════════════════════
-- Two problems with the financing "prequalification":
--   1. leads.financial_qualification_tier DEFAULTed to 'tier_c', so a lead that
--      was NEVER assessed looked identical to a lead assessed-and-found-cold.
--   2. The "tier" is a regex/keyword heuristic over conversation text — NOT a
--      credit check. Nothing in the schema said "this was actually assessed".
--
-- Fix: stop defaulting the tier (NULL = not assessed) and add an explicit
-- assessment status. The qualifier sets status='assessed' when it writes signals.

-- 1. Explicit assessment status.
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS financial_qualification_status text NOT NULL DEFAULT 'unassessed'
    CHECK (financial_qualification_status IN ('unassessed', 'assessed'));

COMMENT ON COLUMN public.leads.financial_qualification_status IS 'unassessed = no financing signal yet; assessed = the text-derived qualifier ran (financial_signals populated). NOT a credit check.';
COMMENT ON COLUMN public.leads.financial_qualification_tier IS 'Text-derived financing SIGNAL (regex/keyword over conversation), NOT a credit grade. NULL until assessed. tier_a/b/c/d.';

-- 2. Stop fabricating a grade for new rows.
ALTER TABLE public.leads ALTER COLUMN financial_qualification_tier DROP DEFAULT;

-- 3. Backfill: rows whose signals were actually written are 'assessed'.
UPDATE public.leads
  SET financial_qualification_status = 'assessed'
  WHERE financial_signals ? 'last_updated';

-- 4. Clear the fake grade from rows that were never assessed (the tier_c default
--    they inherited). Genuinely assessed-cold leads keep their tier_c.
UPDATE public.leads
  SET financial_qualification_tier = NULL
  WHERE financial_qualification_tier = 'tier_c'
    AND NOT (financial_signals ? 'last_updated');
