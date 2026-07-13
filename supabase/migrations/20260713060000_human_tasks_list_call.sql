-- ═══════════════════════════════════════════════════════════════
-- Smart List → Call Queue
--
-- Lets staff turn a Smart List (e.g. "TMJ leads not contacted in 2 weeks")
-- into a batch of human call tasks that land in the existing /tasks queue.
--
-- 1. human_tasks.kind gains 'list_call' — the on-demand, staff-created call
--    task (distinct from the allocation-engine kinds, which are automatic).
-- 2. Two nullable traceability columns:
--      source_smart_list_id — which Smart List spawned the task (for filtering
--        the queue and reporting; SET NULL if the list is later deleted).
--      created_by           — the staff user who generated the queue (existing
--        allocation-created tasks have no human author, so it stays nullable).
--
-- Guarded (human_tasks is branch-new) and idempotent, mirroring the
-- 20260711190000 call_review migration.
-- ═══════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.human_tasks') IS NOT NULL THEN
    -- kind += 'list_call'
    ALTER TABLE public.human_tasks DROP CONSTRAINT IF EXISTS human_tasks_kind_check;
    ALTER TABLE public.human_tasks ADD CONSTRAINT human_tasks_kind_check CHECK (kind IN (
      'inbound_reply', 'first_touch', 'nurture_step', 'stage_automation',
      'recommendation', 'sla_breach_review', 'call_review', 'list_call'
    ));

    -- Traceability columns (nullable; existing rows keep NULL).
    ALTER TABLE public.human_tasks
      ADD COLUMN IF NOT EXISTS source_smart_list_id uuid
        REFERENCES public.smart_lists(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS created_by uuid
        REFERENCES public.user_profiles(id) ON DELETE SET NULL;

    -- Queue reads scoped to a Smart List (only the rows that carry one).
    CREATE INDEX IF NOT EXISTS human_tasks_source_smart_list_idx
      ON public.human_tasks (source_smart_list_id)
      WHERE source_smart_list_id IS NOT NULL;
  END IF;
END $$;
