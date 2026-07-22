-- DRIFT RECONCILIATION — captured verbatim from
-- supabase_migrations.schema_migrations version 20260609152808 (applied to prod,
-- no local file). See docs/MIGRATION_DRIFT.md.
--
-- Point-in-time security baseline, two sweeps:
--   1. enable RLS on every public table that doesn't already have it;
--   2. revoke EXECUTE from anon + public on every SECURITY DEFINER function in
--      public — these bypass RLS by design, so they must not be callable
--      unauthenticated (guards the p_org_id side-door class, see
--      [[secdef-crossorg-sidedoor]]).
--
-- ⚠️ REPLAY CAVEAT: sweep 2 covers only functions that exist AT THIS POINT in the
-- migration order. On a fresh replay, SECURITY DEFINER functions created by LATER
-- migrations are NOT re-revoked here — prod behaved the same way, so this file is
-- a faithful capture, but a from-scratch rebuild should re-run this baseline (or
-- an equivalent) AFTER all migrations, and audit new secdef functions for their
-- own grants. The RLS-on-new-tables gap is closed going forward by the companion
-- event trigger (20260609165903); there is no equivalent auto-revoke for grants.

do $$
declare r record;
begin
  for r in select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' and not c.relrowsecurity loop
    begin execute format('alter table public.%I enable row level security;', r.relname);
    exception when others then raise notice 'rls skip %: %', r.relname, sqlerrm; end;
  end loop;
end $$;
do $$
declare r record;
begin
  for r in select p.proname, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prosecdef loop
    begin execute format('revoke execute on function public.%I(%s) from anon, public;', r.proname, r.args);
    exception when others then raise notice 'revoke skip %: %', r.proname, sqlerrm; end;
  end loop;
end $$;
