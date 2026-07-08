-- ============================================================================
-- 20260707 — user_profiles INSERT privilege guard (closes an INSERT privesc)
-- ============================================================================
-- The "Admins can manage user profiles" policy is FOR ALL with a USING clause
-- and NO WITH CHECK. For INSERT, Postgres falls back to USING, which constrains
-- only the new row's organization_id — NOT role. The 20260627 privilege trigger
-- fires on UPDATE only, so it does not cover INSERT.
--
-- Consequence: a practice-level admin (doctor_admin/office_manager/owner) can
-- PostgREST-INSERT a user_profiles row for a colleague's existing auth.users id
-- in their own org with role='agency_admin'. That colleague then satisfies
-- get_user_org_id()'s agency-admin join and can enter ANY tenant → full
-- cross-practice PHI. This trigger pins role/org on INSERT the same way the
-- UPDATE guard does.
-- ============================================================================

create or replace function public.guard_user_profile_privileged_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor      uuid := auth.uid();
  actor_role text;
  actor_org  uuid;
begin
  -- Trusted server-side code (service role / cron / the on_auth_user_created
  -- signup trigger) carries no JWT → auth.uid() is NULL. Those paths create the
  -- first owner and invited members and must pass through unchanged.
  if actor is null then
    return new;
  end if;

  select role, organization_id
    into actor_role, actor_org
  from public.user_profiles
  where id = actor;

  -- Only an agency_admin may create a profile carrying a platform-level role.
  if new.role in ('agency_admin', 'owner')
     and coalesce(actor_role, '') <> 'agency_admin' then
    raise exception 'Insufficient privilege to create a % profile', new.role;
  end if;

  -- An authenticated (non-agency) caller may only create users inside their own
  -- organization — blocks cross-tenant plants. Agency admins legitimately
  -- provision across orgs, so they are exempt from the org pin.
  if actor_role is not null
     and actor_role <> 'agency_admin'
     and new.organization_id is distinct from actor_org then
    raise exception 'Cannot create a user in a different organization';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_user_profile_privileged_insert on public.user_profiles;
create trigger guard_user_profile_privileged_insert
  before insert on public.user_profiles
  for each row
  execute function public.guard_user_profile_privileged_insert();
