-- DRIFT RECONCILIATION — captured verbatim from
-- supabase_migrations.schema_migrations version 20260601213616 (applied to prod,
-- no local file). See docs/MIGRATION_DRIFT.md.
--
-- Pins search_path on the RLS workhorse get_user_org_id() so a SECURITY DEFINER
-- function can't be hijacked by a caller-set search_path. It also encodes the
-- agency-admin context switch: an agency_admin's effective org is their
-- agency_active_org.active_org_id, everyone else's is their own
-- user_profiles.organization_id. Verify with:
--   select pg_get_functiondef(oid) from pg_proc where proname='get_user_org_id';

create or replace function public.get_user_org_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select a.active_org_id
      from public.agency_active_org a
      join public.user_profiles p on p.id = a.user_id
      where a.user_id = auth.uid()
        and p.role = 'agency_admin'
    ),
    (select organization_id from public.user_profiles where id = auth.uid())
  );
$$;
