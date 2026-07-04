-- Pipeline stage counts for the practice-admin ops dashboard.
-- Returns each pipeline stage with how many active (not lost/disqualified)
-- leads sit in it, so the ops board can show "leads by stage" without pulling
-- 45k rows into the app (which would silently truncate at PostgREST's 1000-row
-- cap). Mirrors the leads_filter_facets(p_org) shape.
--
-- SECURITY INVOKER (default): the caller's RLS on leads + pipeline_stages
-- applies, so passing another org's id returns zero rows. p_org is defense in
-- depth + matches resolveActiveOrg()'s effective org (an agency admin acting in
-- a client resolves to that client via get_user_org_id()).
create or replace function public.pipeline_stage_counts(p_org uuid)
returns table (
  stage_id uuid,
  name text,
  stage_position int,
  lead_count bigint
)
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  select
    s.id,
    s.name,
    s.position,
    count(l.id)
  from public.pipeline_stages s
  -- s.position aliases to stage_position via the RETURNS TABLE column order
  left join public.leads l
    on l.stage_id = s.id
    and l.organization_id = p_org
    and l.status not in ('disqualified', 'lost')
  where s.organization_id = p_org
  group by s.id, s.name, s.position
  order by s.position;
$$;

grant execute on function public.pipeline_stage_counts(uuid) to authenticated;
