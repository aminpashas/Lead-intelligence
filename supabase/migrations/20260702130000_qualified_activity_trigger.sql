-- ============================================================================
-- 20260702130000 — log 'qualified' lead activities (fixes permanently-zero KPIs)
-- ============================================================================
-- Both agent_performance_daily (031, leads_qualified + funnel qualification_rate)
-- and the treatment-success-rate KPI (20260608) count lead_activities rows with
-- activity_type = 'qualified' — but nothing in the app ever inserts that type,
-- so those counters have been 0 since launch. (The sibling 'disqualified'
-- counter works only because the AI disqualification sweep logs it manually.)
--
-- leads.status = 'qualified' is written from at least four independent paths
-- (PATCH /api/leads/[id], the AI agent's update_lead_stage tool, funnel
-- update_status automations, imports/bridges), each with different — or no —
-- activity logging. Rather than chase every producer in app code, this trigger
-- materializes the qualification event at the source of truth: the status
-- transition on public.leads itself. Every current and future write path is
-- covered, including raw SQL.
--
-- Semantics:
--   * Fires when a lead's status first enters the qualified-or-beyond set
--     (qualified, consultation_scheduled, … completed). Leads that book a
--     consultation straight from 'contacted' skip the literal 'qualified'
--     status — booked implies qualified, and excluding the fastest converters
--     would be the worst possible KPI skew.
--   * Logged at most once per lead (dedup on an existing 'qualified' activity),
--     so requalification loops don't inflate funnel qualification_rate.
--     Per-agent attribution in agent_performance_daily is unaffected — it joins
--     through messages, not through this row's author.
--   * The insert is best-effort: a failure raises a WARNING but never blocks
--     the underlying lead update.
--
-- Includes a one-time backfill derived from historical status_changed /
-- stage_advanced activities (accurate timestamps where available).
-- ============================================================================

-- 0) Ensure activity_type permits 'qualified'. Prod already carries the relaxed
--    snake_case format check (applied 2026-07-02; migration on branch
--    zen-swirles-f627ef, commit a47918a) — this is an idempotent no-op there,
--    but makes this file self-contained for branch replays where the original
--    002 whitelist (which lacks 'qualified') would still be in force.
alter table public.lead_activities drop constraint if exists lead_activities_activity_type_check;
alter table public.lead_activities add constraint lead_activities_activity_type_check
  check (activity_type ~ '^[a-z][a-z0-9_]*$');

-- 1) Trigger function --------------------------------------------------------
create or replace function public.log_lead_qualified()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  qualified_plus constant text[] := array[
    'qualified', 'consultation_scheduled', 'consultation_completed',
    'treatment_presented', 'financing', 'contract_sent', 'contract_signed',
    'scheduled', 'in_treatment', 'completed'
  ];
begin
  if new.status = any(qualified_plus)
     and (tg_op = 'INSERT'
          or (old.status is distinct from new.status
              and not (old.status = any(qualified_plus))))
     and not exists (
       select 1 from public.lead_activities la
       where la.lead_id = new.id
         and la.activity_type = 'qualified'
     )
  then
    begin
      insert into public.lead_activities (organization_id, lead_id, activity_type, title, metadata)
      values (
        new.organization_id,
        new.id,
        'qualified',
        'Lead qualified',
        jsonb_build_object(
          'from', case when tg_op = 'UPDATE' then old.status end,
          'to', new.status,
          'source', 'status_trigger'
        )
      );
    exception when others then
      raise warning 'log_lead_qualified: could not log activity for lead % (%)', new.id, sqlerrm;
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_leads_log_qualified on public.leads;
create trigger trg_leads_log_qualified
  after insert or update of status on public.leads
  for each row execute function public.log_lead_qualified();

-- 2) Backfill ----------------------------------------------------------------
-- One 'qualified' activity per lead that demonstrably reached qualified-or-
-- beyond: either it currently sits in that set, or a surviving
-- status_changed / stage_advanced activity records a transition into it.
-- Timestamp = the earliest such recorded transition when one exists (accurate),
-- else the lead's updated_at (best available; pre-2026-07-02 activity history
-- was largely dropped by the old whitelist constraint and is unrecoverable).
insert into public.lead_activities (organization_id, lead_id, activity_type, title, metadata, created_at)
select
  l.organization_id,
  l.id,
  'qualified',
  'Lead qualified',
  jsonb_build_object('source', 'backfill_20260702', 'status_at_backfill', l.status),
  coalesce(first_evt.created_at, l.updated_at, l.created_at, now())
from public.leads l
left join lateral (
  select la.created_at
  from public.lead_activities la
  where la.lead_id = l.id
    and la.activity_type in ('status_changed', 'stage_advanced')
    and la.metadata->>'to' in (
      'qualified', 'consultation_scheduled', 'consultation_completed',
      'treatment_presented', 'financing', 'contract_sent', 'contract_signed',
      'scheduled', 'in_treatment', 'completed'
    )
  order by la.created_at asc
  limit 1
) first_evt on true
where (
    l.status in (
      'qualified', 'consultation_scheduled', 'consultation_completed',
      'treatment_presented', 'financing', 'contract_sent', 'contract_signed',
      'scheduled', 'in_treatment', 'completed'
    )
    or first_evt.created_at is not null
  )
  and not exists (
    select 1 from public.lead_activities x
    where x.lead_id = l.id and x.activity_type = 'qualified'
  );
