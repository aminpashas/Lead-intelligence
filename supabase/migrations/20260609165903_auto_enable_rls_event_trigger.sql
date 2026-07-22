-- DRIFT RECONCILIATION — captured verbatim from
-- supabase_migrations.schema_migrations version 20260609165903 (applied to prod,
-- no local file). See docs/MIGRATION_DRIFT.md.
--
-- Closes the forward gap left by the RLS baseline (20260609152808): an event
-- trigger that enables RLS on any newly CREATEd public table automatically, so a
-- table added later can never ship without row-level security. (There is no
-- equivalent auto-guard for SECURITY DEFINER function grants — those still need a
-- manual revoke; see the baseline migration's replay caveat.)

create or replace function public.auto_enable_rls_on_new_tables()
returns event_trigger language plpgsql security definer set search_path = '' as $fn$
declare obj record;
begin
  for obj in select * from pg_event_trigger_ddl_commands() where command_tag='CREATE TABLE' and object_type='table' loop
    if exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.oid=obj.objid and n.nspname='public' and c.relkind='r' and not c.relrowsecurity) then
      execute format('alter table %s enable row level security;', obj.object_identity);
    end if;
  end loop;
end;
$fn$;
drop event trigger if exists trg_auto_enable_rls;
create event trigger trg_auto_enable_rls on ddl_command_end when tag in ('CREATE TABLE') execute function public.auto_enable_rls_on_new_tables();
