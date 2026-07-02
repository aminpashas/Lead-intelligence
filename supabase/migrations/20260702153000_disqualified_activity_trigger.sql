-- ============================================================================
-- 20260702153000 — log 'disqualified' lead activities at the status transition
-- ============================================================================
-- Companion to trg_leads_log_qualified (20260702130000, applied to prod
-- 2026-07-02). Both agent_performance_daily.leads_disqualified (031) and the
-- technique-feedback 'backfired' outcome count lead_activities rows with
-- activity_type = 'disqualified', but until now the ONLY producer was the AI
-- disqualification sweep (src/lib/ai/disqualification.ts). Human paths never
-- logged it: PATCH /api/leads/[id] logs only 'status_changed', and the bulk
-- disqualify action logs nothing — so human disqualifications were invisible
-- to both consumers.
--
-- Worse, the sweep logged activity_type='disqualified' for ALL of its rule
-- actions, including mark_unresponsive and mark_cold, which do not set
-- status='disqualified' — inflating leads_disqualified and producing false
-- 'backfired' technique scores. The sweep's manual insert is being retyped to
-- 'automation_rule_applied' in the same change; this trigger becomes the sole
-- producer of 'disqualified' activities.
--
-- Semantics (deliberately different from trg_leads_log_qualified):
--   * Fires on every transition INTO status 'disqualified' — NOT once per
--     lead. Unlike qualification, disqualification legitimately recurs
--     (disqualified → reactivated → disqualified again), so the only dedup is
--     the transition guard itself (old.status must differ). Re-saving an
--     already-disqualified lead does not log.
--   * Captures leads.disqualified_reason (written by both the AI sweep and
--     the bulk route) into description + metadata.reason, so the reason the
--     sweep used to carry in its manual insert survives.
--   * Best-effort: failure to log raises a WARNING, never blocks the update.
--
-- Deploy ordering: apply this migration together with the app deploy that
-- retypes the sweep's insert. If the old sweep code runs after the trigger
-- exists, its daily run would double-log its own (AI) disqualifications for
-- that window; human paths are unaffected either way.
-- ============================================================================

-- 0) Ensure activity_type permits arbitrary snake_case values. Idempotent
--    no-op on prod (relaxed constraint applied 2026-07-02), but keeps this
--    file self-contained for branch replays still carrying the 002 whitelist.
alter table public.lead_activities drop constraint if exists lead_activities_activity_type_check;
alter table public.lead_activities add constraint lead_activities_activity_type_check
  check (activity_type ~ '^[a-z][a-z0-9_]*$');

-- 1) Trigger function --------------------------------------------------------
create or replace function public.log_lead_disqualified()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'disqualified'
     and (tg_op = 'INSERT' or old.status is distinct from new.status)
  then
    begin
      insert into public.lead_activities (organization_id, lead_id, activity_type, title, description, metadata)
      values (
        new.organization_id,
        new.id,
        'disqualified',
        'Lead disqualified',
        new.disqualified_reason,
        jsonb_build_object(
          'from', case when tg_op = 'UPDATE' then old.status end,
          'to', new.status,
          'reason', new.disqualified_reason,
          'source', 'status_trigger'
        )
      );
    exception when others then
      raise warning 'log_lead_disqualified: could not log activity for lead % (%)', new.id, sqlerrm;
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_leads_log_disqualified on public.leads;
create trigger trg_leads_log_disqualified
  after insert or update of status on public.leads
  for each row execute function public.log_lead_disqualified();

-- 2) Backfill ----------------------------------------------------------------
-- One 'disqualified' activity per lead that demonstrably reached the status:
-- either it sits in 'disqualified' now, or a surviving status_changed activity
-- records a transition into it (covers since-reactivated leads). Timestamp =
-- the earliest such recorded transition when one exists, else updated_at.
-- Recurrences (multiple disqualification cycles) cannot be reconstructed from
-- surviving history — the backfill is one row per lead, matching how the
-- pre-fix data would have looked at best.
-- Leads the AI sweep already logged (the sole pre-fix producer) are skipped by
-- the not-exists guard, so their original richer activities remain canonical.
insert into public.lead_activities (organization_id, lead_id, activity_type, title, description, metadata, created_at)
select
  l.organization_id,
  l.id,
  'disqualified',
  'Lead disqualified',
  l.disqualified_reason,
  jsonb_build_object(
    'reason', l.disqualified_reason,
    'source', 'backfill_20260702',
    'status_at_backfill', l.status
  ),
  coalesce(first_evt.created_at, l.updated_at, l.created_at, now())
from public.leads l
left join lateral (
  select la.created_at
  from public.lead_activities la
  where la.lead_id = l.id
    and la.activity_type = 'status_changed'
    and la.metadata->>'to' = 'disqualified'
  order by la.created_at asc
  limit 1
) first_evt on true
where (l.status = 'disqualified' or first_evt.created_at is not null)
  and not exists (
    select 1 from public.lead_activities x
    where x.lead_id = l.id and x.activity_type = 'disqualified'
  );
