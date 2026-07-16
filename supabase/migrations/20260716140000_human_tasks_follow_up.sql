-- ═══════════════════════════════════════════════════════════════
-- human_tasks.kind += 'follow_up'  (task sweep)
--
-- The task sweep materializes STATE-shaped work — a follow-up date that has
-- arrived, a patient waiting on a reply, a ready-to-book lead going stale —
-- into real task rows. It uses one dedicated kind so its rows can never dedupe
-- onto (or be reconciled by) the event-driven allocation engine's kinds.
--
-- NOTE ON THE KIND LIST: every migration that touches this constraint drops and
-- recreates it with a full hardcoded list, so each one must carry EVERY kind
-- added before it. 20260713060000 (list_call) and 20260713120000 (manual) landed
-- out of order in production, and replaying list_call verbatim would have
-- silently dropped 'manual'. Keep this list complete and additive.
--
-- Guarded + idempotent, mirroring the 20260713120000 manual migration.
-- ═══════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.human_tasks') IS NOT NULL THEN
    ALTER TABLE public.human_tasks DROP CONSTRAINT IF EXISTS human_tasks_kind_check;
    ALTER TABLE public.human_tasks ADD CONSTRAINT human_tasks_kind_check CHECK (kind IN (
      'inbound_reply', 'first_touch', 'nurture_step', 'stage_automation',
      'recommendation', 'sla_breach_review', 'call_review', 'list_call', 'manual',
      'follow_up'
    ));

    -- The sweep's hot path: "every task this rule ever produced for this org",
    -- i.e. kind='follow_up' + dedupe_key LIKE 'sweep:<rule>:%'. text_pattern_ops
    -- makes the prefix LIKE index-usable regardless of collation.
    CREATE INDEX IF NOT EXISTS human_tasks_sweep_dedupe_idx
      ON public.human_tasks (organization_id, dedupe_key text_pattern_ops)
      WHERE kind = 'follow_up';
  END IF;
END $$;
