-- ═══════════════════════════════════════════════════════════════
-- Manual (staff-created) tasks
--
-- Until now every human_tasks row was minted by the D1 allocation engine or
-- the Smart List call-queue. This lets staff hand-create a task from the
-- /tasks page — a plain to-do with a title, optional detail, a priority, an
-- optional deadline (due_at) and an optional assignee (assigned_to).
--
-- 1. human_tasks.kind gains 'manual' — the generic staff-authored to-do.
-- 2. New `priority` column (low | normal | high | urgent, default 'normal').
--    Allocation-created rows keep the default; manual tasks set it explicitly.
--
-- Guarded (human_tasks is branch-new) and idempotent, mirroring the
-- 20260713060000 list_call migration.
-- ═══════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.human_tasks') IS NOT NULL THEN
    -- kind += 'manual'
    ALTER TABLE public.human_tasks DROP CONSTRAINT IF EXISTS human_tasks_kind_check;
    ALTER TABLE public.human_tasks ADD CONSTRAINT human_tasks_kind_check CHECK (kind IN (
      'inbound_reply', 'first_touch', 'nurture_step', 'stage_automation',
      'recommendation', 'sla_breach_review', 'call_review', 'list_call', 'manual'
    ));

    -- Priority (nullable-safe: existing rows adopt the default 'normal').
    ALTER TABLE public.human_tasks
      ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal'
        CHECK (priority IN ('low', 'normal', 'high', 'urgent'));
  END IF;
END $$;
