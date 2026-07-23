-- human_tasks.status += 'delegated_to_ai'  (human-initiated AI delegation)
--
-- WHAT: a human working the /tasks queue can hand a task to the AI ("let the AI
-- do it"). The AI generates the reply, the human reviews the exact outbound
-- text, and on confirm the AI sends it. The task then closes in this NEW
-- terminal state.
--
-- WHY A DISTINCT STATUS (not 'taken_by_ai'): 'taken_by_ai' already means the
-- CLOCK-driven SLA takeover — the human window elapsed unanswered and the AI
-- stepped in on its own (see 20260711160000 + lib/automation/sla.ts). A human
-- deliberately delegating is a different act with different accountability, and
-- the AI-vs-Human scoreboard must be able to tell them apart. Keeping delegated
-- work OUT of 'done' also matters: automation_scoreboard counts human throughput
-- as status='done', so a delegated reply must not be credited to the human who
-- pushed the button — the AI wrote it (and the outbound message carries
-- sender_type='ai', so it lands on the AI lane where it belongs).
--
-- STATUS CONSTRAINT REPLAY: unlike the kind constraint, the status CHECK has
-- never been replayed since the table was created, so this is its first re-add.
-- Still list every value explicitly and additively.
--
-- Guarded (human_tasks is branch-new) and idempotent.
DO $$
BEGIN
  IF to_regclass('public.human_tasks') IS NOT NULL THEN
    ALTER TABLE public.human_tasks DROP CONSTRAINT IF EXISTS human_tasks_status_check;
    ALTER TABLE public.human_tasks ADD CONSTRAINT human_tasks_status_check CHECK (status IN (
      'open', 'claimed', 'done', 'expired', 'taken_by_ai', 'dismissed', 'delegated_to_ai'
    ));
  END IF;
END $$;
