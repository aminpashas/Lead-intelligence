-- human_tasks.kind += 'callback' (lead hold).
--
-- Setting a hold on a lead mints exactly one live 'callback' task whose due_at
-- is the hold date — the "active plan" the rep sees on /tasks. A dedicated kind
-- keeps it from deduping onto the allocation engine's or the sweep's rows.
--
-- CONSTRAINT REPLAY: every migration touching human_tasks_kind_check recreates
-- the FULL list. This carries every kind added before 'callback'. Do not trim.
-- Guarded + idempotent.
DO $$
BEGIN
  IF to_regclass('public.human_tasks') IS NOT NULL THEN
    ALTER TABLE public.human_tasks DROP CONSTRAINT IF EXISTS human_tasks_kind_check;
    ALTER TABLE public.human_tasks ADD CONSTRAINT human_tasks_kind_check CHECK (kind IN (
      'inbound_reply', 'first_touch', 'nurture_step', 'stage_automation',
      'recommendation', 'sla_breach_review', 'call_review', 'list_call', 'manual',
      'follow_up', 'callback'
    ));
  END IF;
END $$;
