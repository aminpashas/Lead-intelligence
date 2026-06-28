-- ============================================================================
-- 20260627 — user_profiles team-management RLS  (R1 + R2 from the audit)
-- ============================================================================
-- Follow-ups surfaced while applying the C1 privilege-escalation fix
-- ([[user-profiles-privesc]]). Both stem from prod RLS diverging from the repo
-- migration files ([[migration-replay-drift]]):
--
-- R1 — `user_profiles_delete` is `USING (organization_id = get_user_org_id())`
--      with no role gate, so ANY authenticated org member can hard-DELETE any
--      colleague's profile in their org via PostgREST. The app only ever
--      soft-deletes (is_active=false), so locking hard delete to admins changes
--      no legitimate flow.
--
-- R2 — prod has NO admin policy on user_profiles: the only UPDATE policy is
--      `user_profiles_update USING (id = auth.uid())` (self only). The team/[id]
--      admin routes use the authenticated client, so an admin updating/deactivating
--      ANOTHER member currently matches no policy → 0 rows → team management is
--      silently non-functional. Add an org-scoped, admin-only UPDATE policy.
--
-- is_admin_role() (defined in migration 020) is ALSO missing on prod, so we
-- (re)create it here as the single DB-level admin predicate. The C1 trigger
-- (guard_user_profile_privileged_columns) and the app-layer rank guard
-- (canActOnRole) remain in force on top of these policies — defense in depth:
-- this policy lets admins act on org members, the trigger still blocks self-role
-- changes, cross-org moves, and privileged-role grants by non-agency-admins.
-- ============================================================================

-- DB-level admin predicate (mirrors the app's isAdminRole / migration 020).
create or replace function public.is_admin_role()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.user_profiles
    where id = auth.uid()
      and role in ('doctor_admin', 'office_manager', 'owner', 'admin', 'agency_admin')
  );
$$;

-- R1: hard DELETE on user_profiles → admins within the caller's (effective) org only.
do $$
begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'user_profiles'
      and policyname = 'user_profiles_delete'
  ) then
    execute 'alter policy user_profiles_delete on public.user_profiles '
         || 'using (organization_id = public.get_user_org_id() and public.is_admin_role())';
  else
    execute 'create policy user_profiles_delete on public.user_profiles for delete '
         || 'using (organization_id = public.get_user_org_id() and public.is_admin_role())';
  end if;
end $$;

-- R2: admins may UPDATE team members in their org (org-scoped both directions).
drop policy if exists user_profiles_admin_update on public.user_profiles;
create policy user_profiles_admin_update on public.user_profiles
  for update
  using      (organization_id = public.get_user_org_id() and public.is_admin_role())
  with check (organization_id = public.get_user_org_id() and public.is_admin_role());
