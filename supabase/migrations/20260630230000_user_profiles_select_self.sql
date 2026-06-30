-- 20260630 — user_profiles SELECT: always allow reading your OWN row
--
-- Bug (production login loop): the prod `user_profiles_select` policy was
--     USING (organization_id = get_user_org_id())
-- with no `id = auth.uid()` clause. For an agency_admin who has "entered" a
-- client account, get_user_org_id() resolves to the CLIENT org, but their own
-- user_profiles row lives in their HOME org — so the row failed the policy and
-- they could not read their own profile. Every authenticated layout does
--     from('user_profiles').select('*').eq('id', user.id).single()
-- so .single() returned 0 rows ("Cannot coerce the result to a single JSON
-- object") and redirect('/login') fired on every page → an endless OAuth/login
-- loop (only for agency admins acting inside a client account).
--
-- Fix: also allow `id = auth.uid()` (own row), independent of effective org.
-- This is safe — reading your own profile is not privilege escalation. Role
-- self-escalation stays blocked by the UPDATE policies' WITH CHECK and the
-- guard_user_profile_privileged_columns trigger (migration 20260627).
--
-- Idempotent + name-agnostic: the SELECT policy is prod-only (migration-namespace
-- drift), so we locate it by command rather than assuming a name, and create one
-- if a fresh environment has none.

do $$
declare
  pol text;
begin
  select policyname into pol
  from pg_policies
  where schemaname = 'public'
    and tablename  = 'user_profiles'
    and cmd        = 'SELECT'
  limit 1;

  if pol is not null then
    execute format(
      'alter policy %I on public.user_profiles '
      || 'using ((id = auth.uid()) or (organization_id = public.get_user_org_id()))',
      pol
    );
  else
    create policy user_profiles_select on public.user_profiles
      for select
      using ((id = auth.uid()) or (organization_id = public.get_user_org_id()));
  end if;
end $$;
