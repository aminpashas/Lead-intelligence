-- human_tasks: reviewed_at / reviewed_by  (lead-page task review)
--
-- WHAT: a human working a lead can confirm a task is "still relevant" without
-- changing its status. reviewed_at records that confirmation; reviewed_by is who
-- did it. This makes "a human looked at this today" queryable state rather than
-- an inference, and drives the lead page's "Possibly moot" flag (a task is moot
-- only if it has NOT been reviewed since the lead was last contacted).
--
-- COLUMNS ONLY — this migration deliberately does NOT touch human_tasks_kind_check
-- or human_tasks_status_check. No new kind or status is introduced, so it avoids
-- the full-list drop/recreate replay hazard those constraints carry (see
-- 20260716140000_human_tasks_follow_up.sql). reviewed_at mirrors the naming
-- already used by campaign_review_drafts.reviewed_at.
--
-- Guarded (human_tasks is branch-new) and idempotent.
DO $$
BEGIN
  IF to_regclass('public.human_tasks') IS NOT NULL THEN
    ALTER TABLE public.human_tasks
      ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
      ADD COLUMN IF NOT EXISTS reviewed_by uuid
        REFERENCES public.user_profiles(id) ON DELETE SET NULL;
  END IF;
END $$;
