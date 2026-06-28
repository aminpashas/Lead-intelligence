-- ═══════════════════════════════════════════════════════════════
-- Phase 6.1 — Backfill leads.external_ref from legacy notes
-- ═══════════════════════════════════════════════════════════════
-- The DGS writeback trigger resolves the correlation id via
--   coalesce(external_ref, notes-regex 'dgs_lead_id:<uuid>').
-- Leads created before external_ref existed only carry the id inside notes, so
-- the regex fallback runs on every status change (slow, and silently skips the
-- writeback if the regex misses). Promote those ids into the first-class column
-- once so the fallback is no longer needed for them.
--
-- Idempotent: only touches rows where external_ref IS NULL and notes contains a
-- dgs_lead_id. Safe to re-run.

UPDATE public.leads
  SET external_ref = substring(notes FROM 'dgs_lead_id:\s*([0-9a-fA-F-]{36})')
  WHERE external_ref IS NULL
    AND notes ~ 'dgs_lead_id:\s*[0-9a-fA-F-]{36}';
