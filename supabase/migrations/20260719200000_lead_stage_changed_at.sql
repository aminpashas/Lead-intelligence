-- Stage-move recency — make a moved lead stay at the top of its new column.
--
-- The pipeline board sorts each column `ai_score desc, created_at desc` and
-- renders only the first 80 cards. So a lead dragged into a large column did
-- not merely sink on the next refresh: if its score fell outside the column's
-- top 80 it dropped out of the rendered sample entirely and vanished from the
-- board, even though the header still counted it.
--
-- `stage_changed_at` records when a lead last actually changed stage. It stays
-- NULL for leads nobody has ever moved, and the board sorts
-- `stage_changed_at desc nulls last, ai_score desc, created_at desc` — so the
-- ~52k never-moved leads keep their exact current ordering, while anything a
-- human (or an automation) has triaged surfaces above them, freshest first.
--
-- Deliberately NOT backfilled. Stamping every existing row would both destroy
-- that nulls-last property (making the column meaningless) and fire the
-- per-row audit trigger (trg_audit_leads) 52k times.

alter table leads add column if not exists stage_changed_at timestamptz;

comment on column leads.stage_changed_at is
  'When the lead last changed stage_id. NULL = never moved. Maintained by '
  'trg_leads_stage_changed_at; drives pipeline column ordering.';

-- Mirrors the board query exactly, including `desc nulls last` — a plain DESC
-- index is NULLS FIRST and would not serve this sort.
create index if not exists idx_leads_stage_recency
  on leads (
    organization_id,
    stage_id,
    stage_changed_at desc nulls last,
    ai_score desc,
    created_at desc
  );

-- Maintained by trigger rather than at the call site: leads change stage from
-- the board, the API, the GHL reconcile job, cron sweeps and bulk scripts, and
-- every one of those paths should stamp the column.
create or replace function public.touch_lead_stage_changed_at()
returns trigger
language plpgsql
as $$
begin
  new.stage_changed_at := now();
  return new;
end $$;

drop trigger if exists trg_leads_stage_changed_at on leads;

-- BEFORE UPDATE OF stage_id + the WHEN guard means a no-op restage (writing the
-- same stage_id back) does not bump recency and shuffle the board.
create trigger trg_leads_stage_changed_at
  before update of stage_id on leads
  for each row
  when (old.stage_id is distinct from new.stage_id)
  execute function public.touch_lead_stage_changed_at();
