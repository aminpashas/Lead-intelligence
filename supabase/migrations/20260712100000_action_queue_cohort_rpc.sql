-- ── Action-queue cohort membership + paginated lead lists ──────────────────
--
-- The Action Center tiles (get_action_queue) only return COUNTS. This adds:
--   1. analytics_in_action_cohort(l, cohort) — the single source of truth for
--      cohort membership, shared by counts and lists so they can never drift.
--   2. get_action_queue_cohort(org, cohort, limit, offset) — the paginated
--      lead list behind each tile/recommendation, powering the drill-down
--      sheet and the "snapshot to Smart List" batch-communication flow.
--
-- Cohort keys (must match ActionQueueCohortKey in src/lib/analytics/deep-types.ts):
--   untouched_new | ready_to_book_stale | inbound_awaiting_reply | engaged_gone_quiet
--
-- Predicates are copied verbatim from get_action_queue
-- (20260711100000_deep_analytics_rpcs.sql) — if you change one, change both,
-- or better: rewrite get_action_queue on top of this helper.

create or replace function analytics_in_action_cohort(l leads, p_cohort text)
returns boolean as $$
  select case p_cohort
    when 'untouched_new' then
      l.status::text = 'new'
      and analytics_lead_tier(l) = 'untouched'
      and l.created_at < now() - interval '1 day'
    when 'ready_to_book_stale' then
      l.conversation_intent::text = 'ready_to_book'
      and l.status::text not in ('completed', 'disqualified', 'consultation_scheduled', 'consultation_completed')
      and coalesce(l.last_contacted_at, l.created_at) < now() - interval '48 hours'
    when 'inbound_awaiting_reply' then
      l.last_responded_at is not null
      and (l.last_contacted_at is null or l.last_responded_at > l.last_contacted_at)
      and l.last_responded_at > now() - interval '14 days'
      and l.status::text not in ('completed', 'disqualified')
    when 'engaged_gone_quiet' then
      l.conversation_intent::text in ('considering', 'exploring')
      and l.last_responded_at < now() - interval '7 days'
      and l.status::text not in ('completed', 'disqualified', 'consultation_scheduled')
    else false
  end
$$ language sql stable;

create or replace function get_action_queue_cohort(
  p_org_id uuid,
  p_cohort text,
  p_limit int default 50,
  p_offset int default 0
)
returns json as $$
declare
  result json;
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 1000);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
begin
  select json_build_object(
    'cohort', p_cohort,
    'total', (
      select count(*) from leads l
      where l.organization_id = p_org_id
        and analytics_in_action_cohort(l, p_cohort)),
    'leads', coalesce((
      select json_agg(row_to_json(x)) from (
        select
          l.id,
          coalesce(nullif(trim(coalesce(l.first_name, '') || ' ' || coalesce(l.last_name, '')), ''), 'Unknown') as name,
          l.status::text as status,
          l.conversation_intent::text as conversation_intent,
          l.last_contacted_at,
          l.last_responded_at,
          l.created_at
        from leads l
        where l.organization_id = p_org_id
          and analytics_in_action_cohort(l, p_cohort)
        -- Most-recent signal first: last inbound if any, else capture time.
        order by coalesce(l.last_responded_at, l.created_at) desc
        limit v_limit offset v_offset
      ) x), '[]'::json)
  ) into result;
  return result;
end;
$$ language plpgsql stable;
