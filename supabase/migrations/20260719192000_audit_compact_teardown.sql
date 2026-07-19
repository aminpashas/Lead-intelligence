-- ============================================================================
-- Teardown for the one-shot audit_events compaction (20260719191000).
--
-- The compaction ran 2026-07-19 and is complete:
--   239,994 churn rows deleted · 191,226 rows trimmed to delta-only snapshots
--   audit_events 2,740 MB → 440 MB · database 3,674 MB → 1,375 MB
--
-- These helpers are SECURITY DEFINER and exist solely to UPDATE/DELETE rows in
-- an append-only compliance log. They must not outlive the job — even though
-- the WORM trigger is back on (verified tgenabled='O') and would now reject
-- their writes, leaving a purpose-built audit-mutation tool lying around is
-- exactly the kind of thing an auditor asks about.
-- ============================================================================

drop function if exists public.audit_compact_run(int, int);
drop function if exists public.audit_compact_batch(timestamptz, int);
drop table if exists public._audit_compact_progress;
