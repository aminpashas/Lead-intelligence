-- Security hardening sweep, 2026-07-20.
--
-- Everything here was applied directly to PROD during an incident sweep and is
-- recorded so the repo matches the live schema. All statements are idempotent.
--
-- Findings, in order of severity:
--
--  1. CROSS-TENANT READ LEAK. SECURITY DEFINER runs with the owner's rights, so
--     RLS does not apply inside the function body. Analytics functions taking a
--     p_org_id trusted that argument without checking the caller owned the org.
--     Proven on prod: a `nurse` in org A called get_lead_kpis(<org B uuid>) and
--     received org B's real figures (59,468 leads / $412k pipeline), while a
--     direct `select from leads` for org B correctly returned 0 rows. Reachable
--     from the internet because /signup is a public path.
--
--  2. CROSS-TENANT WRITE. reclassify_off_funnel_contacts() had no guard at all
--     and mutates leads. An outsider invoked it against another org successfully.
--
--  3. PII EXPOSURE. `_merge_backup_leads_20260720b` (9 rows incl. first_name,
--     last_name, phone, email) sat in public with RLS off and full anon grants —
--     readable AND writable with the anon key that ships in the browser bundle.
--
--  4. The RLS auto-guard that should have prevented (3) had a two-layer hole:
--     `CREATE TABLE AS SELECT` emits its own command tag, so backups made that
--     way bypassed it entirely.

-- ── 1. Org-authorization guard ───────────────────────────────────────────────
-- Deliberately permissive in two directions so nothing in production breaks:
--   * auth.uid() null  -> service_role / cron / superuser. Enforcing here would
--                         break every cron, which has no JWT.
--   * agency_admin     -> legitimately operates across client orgs.
create or replace function public.assert_org_access(p_org_id uuid)
returns void language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then return; end if;
  if public.is_agency_admin() then return; end if;
  if p_org_id is distinct from public.get_user_org_id() then
    raise exception 'cross-org access denied' using errcode = '42501';
  end if;
end;
$$;

revoke execute on function public.assert_org_access(uuid) from public;
grant  execute on function public.assert_org_access(uuid) to authenticated, service_role;

-- ── 2. Guard the four leaking analytics functions ────────────────────────────
-- These were LANGUAGE sql; converted to plpgsql so they can hold a guard
-- statement. Return types and JSON shapes are unchanged — callers see no
-- difference. Verified on prod: outsider blocked, org member ok, service_role ok.

create or replace function public.get_lead_kpis(p_org_id uuid)
returns json language plpgsql stable security definer
set search_path to 'public', 'pg_temp' as $function$
declare result json;
begin
  perform public.assert_org_access(p_org_id);
  select json_build_object(
    'total_leads', count(*),
    'hot_leads', count(*) filter (where ai_qualification = 'hot'),
    'warm_leads', count(*) filter (where ai_qualification = 'warm'),
    'cold_leads', count(*) filter (where ai_qualification = 'cold'),
    'qualified_leads', count(*) filter (where status in ('qualified','consultation_scheduled','consultation_completed','treatment_presented','financing','contract_sent','contract_signed')),
    'converted_leads', count(*) filter (where status in ('contract_signed','scheduled','in_treatment','completed')),
    'total_pipeline', coalesce(sum(treatment_value), 0),
    'total_revenue', coalesce(sum(actual_revenue), 0),
    'avg_score', coalesce(round(avg(ai_score)), 0),
    'new_last_7d', count(*) filter (where created_at >= now() - interval '7 days'),
    'new_last_30d', count(*) filter (where created_at >= now() - interval '30 days')
  ) into result
  from leads where organization_id = p_org_id;
  return result;
end $function$;

create or replace function public.get_lead_trend(p_org_id uuid)
returns json language plpgsql stable security definer
set search_path to 'public','pg_temp' as $function$
declare result json;
begin
  perform public.assert_org_access(p_org_id);
  with days as (
    select generate_series((current_date - interval '29 days')::date, current_date::date, '1 day'::interval)::date as day
  ),
  daily_leads as (
    select date_trunc('day', created_at)::date as day, count(*) as cnt
      from leads
     where organization_id = p_org_id and created_at >= now() - interval '30 days'
     group by 1
  ),
  daily_conversions as (
    select date_trunc('day', converted_at)::date as day, count(*) as cnt
      from leads
     where organization_id = p_org_id and converted_at >= now() - interval '30 days'
       and converted_at is not null
     group by 1
  )
  select json_agg(json_build_object('date', d.day, 'leads', coalesce(dl.cnt,0), 'conversions', coalesce(dc.cnt,0)) order by d.day)
    into result
    from days d
    left join daily_leads dl on dl.day = d.day
    left join daily_conversions dc on dc.day = d.day;
  return result;
end $function$;

create or replace function public.get_qualification_distribution(p_org_id uuid)
returns json language plpgsql stable security definer
set search_path to 'public','pg_temp' as $function$
declare result json;
begin
  perform public.assert_org_access(p_org_id);
  select json_build_object(
    'hot', count(*) filter (where ai_qualification = 'hot'),
    'warm', count(*) filter (where ai_qualification = 'warm'),
    'cold', count(*) filter (where ai_qualification = 'cold'),
    'unqualified', count(*) filter (where ai_qualification = 'unqualified'),
    'unscored', count(*) filter (where ai_qualification = 'unscored' or ai_qualification is null)
  ) into result
  from leads where organization_id = p_org_id;
  return result;
end $function$;

create or replace function public.get_source_breakdown(p_org_id uuid)
returns json language plpgsql stable security definer
set search_path to 'public','pg_temp' as $function$
declare result json;
begin
  perform public.assert_org_access(p_org_id);
  select coalesce(json_agg(json_build_object('source', source_type, 'count', cnt) order by cnt desc), '[]'::json)
    into result
    from (
      select coalesce(source_type,'unknown') as source_type, count(*) as cnt
        from leads where organization_id = p_org_id group by source_type
    ) sub;
  return result;
end $function$;

-- ── 3. Lock down the unguarded MUTATING function ─────────────────────────────
-- reclassify_off_funnel_contacts() had no org check and rewrites leads. Its only
-- caller is the hourly existing-patient-rematch cron, which runs as service_role
-- via withCron() — no end user needs a bulk reclassify. Revoking is safer than
-- rewriting a long plpgsql mutation body.
--
-- NOTE the `from public` line: Postgres grants EXECUTE to PUBLIC by default and
-- roles inherit through it, so `revoke ... from anon` ALONE is a silent no-op
-- that leaves has_function_privilege('anon', ...) still true.
revoke execute on function public.reclassify_off_funnel_contacts(uuid, integer) from public;
revoke execute on function public.reclassify_off_funnel_contacts(uuid, integer) from anon, authenticated;
grant  execute on function public.reclassify_off_funnel_contacts(uuid, integer) to service_role;

-- ── 4. Revoke anon EXECUTE on the remaining SECURITY DEFINER surface ─────────
-- set_audit_config is the sharpest: it sets the app.actor_* GUCs the audit trail
-- uses for attribution, so anon access meant forgeable audit records.
-- Deliberately NOT revoked: is_admin_role / can_manage_team / can_view_billing /
-- is_clinical_role — RLS policies call these and anon needs EXECUTE for policy
-- evaluation on the public patient-portal paths.
revoke execute on function public.set_audit_config(text, text) from public;
revoke execute on function public.recompute_conversation_stats(uuid[]) from public;
revoke execute on function public.recompute_lead_message_stats(uuid[]) from public;
revoke execute on function public.usage_rollup(timestamptz, uuid, timestamptz, uuid) from public;
revoke execute on function public.automation_outcomes(uuid, timestamptz, timestamptz) from public;
revoke execute on function public.automation_scoreboard(uuid, timestamptz, timestamptz) from public;
revoke execute on function public.pipeline_segment_ev(uuid, uuid, text, timestamptz) from public;

-- ── 5. Pin search_path on SECURITY DEFINER functions that lacked it ──────────
-- A definer-rights function with a mutable search_path can be hijacked by a
-- schema earlier on the path. Verified none of these resolve extension functions
-- unqualified, so pinning is safe.
alter function public.count_ai_messages_last_hour(uuid)    set search_path = public, pg_temp;
alter function public.get_lead_kpis(uuid)                  set search_path = public, pg_temp;
alter function public.get_lead_trend(uuid)                 set search_path = public, pg_temp;
alter function public.get_qualification_distribution(uuid) set search_path = public, pg_temp;
alter function public.get_source_breakdown(uuid)           set search_path = public, pg_temp;
alter function public.is_agency_admin()                    set search_path = public, pg_temp;
alter function public.log_consent_change()                 set search_path = public, pg_temp;

-- ── 6. Close the RLS auto-guard hole ─────────────────────────────────────────
-- `CREATE TABLE AS SELECT` emits command_tag 'CREATE TABLE AS', not
-- 'CREATE TABLE'. The guard filtered for the latter in TWO independent places —
-- the event trigger's own WHEN TAG clause and the function body — so every
-- `create table <backup> as select ... from leads` landed unprotected. Fixing
-- only the body changes nothing: the trigger-level filter stops the function
-- from ever running. A tag filter cannot be ALTERed; the trigger must be
-- dropped and recreated.
create or replace function public.auto_enable_rls_on_new_tables()
returns event_trigger language plpgsql security definer
set search_path = ''
as $$
declare obj record;
begin
  for obj in
    select * from pg_event_trigger_ddl_commands()
    where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      and object_type = 'table'
  loop
    if exists (
      select 1 from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where c.oid = obj.objid and n.nspname = 'public'
        and c.relkind = 'r' and not c.relrowsecurity
    ) then
      execute format('alter table %s enable row level security;', obj.object_identity);
    end if;
  end loop;
end;
$$;

drop event trigger if exists trg_auto_enable_rls;
create event trigger trg_auto_enable_rls
  on ddl_command_end
  when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  execute function public.auto_enable_rls_on_new_tables();

-- ── 7. Contain the leaked backup table ───────────────────────────────────────
-- Data deliberately preserved (it is a pre-merge safety copy); only access is
-- removed. Drop it once the merge it backed is confirmed good.
do $$
begin
  if to_regclass('public._merge_backup_leads_20260720b') is not null then
    execute 'alter table public._merge_backup_leads_20260720b enable row level security';
    execute 'revoke all on public._merge_backup_leads_20260720b from anon, authenticated';
  end if;
end $$;
