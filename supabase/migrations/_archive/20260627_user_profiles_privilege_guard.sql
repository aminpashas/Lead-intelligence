-- ============================================================================
-- 20260627 — user_profiles privilege guard  (CRITICAL: closes self-escalation)
-- ============================================================================
-- The UPDATE policy on public.user_profiles has a USING clause but no WITH CHECK.
-- On production this policy is `user_profiles_update`:
--     USING (id = auth.uid())   WITH CHECK = null
-- (The migration-001 source called it "Users can update their own profile"; it
-- was later renamed. Either way the shape — and the hole — is identical.)
--
-- For an UPDATE policy with no WITH CHECK, Postgres reuses the USING expression
-- as the new-row check. `id = auth.uid()` constrains ONLY the id column — it says
-- nothing about `role` or `organization_id`. So any authenticated user can hit
-- PostgREST directly (public anon URL + their own JWT) and run:
--
--     PATCH /rest/v1/user_profiles?id=eq.<self>  {"role":"agency_admin"}
--
-- making themselves an agency admin: is_agency_admin() flips true, migration 018
-- grants SELECT on ALL organizations, they can insert an agency_active_org row
-- (its WITH CHECK now passes), and get_user_org_id() resolves them into ANY
-- tenant — full cross-practice PHI access. Every app-layer isAdminRole() check is
-- bypassed because the attacker never calls our Next.js routes.
--
-- Verified on a Postgres 17 branch: without this guard a `member` rewrites its own
-- role to `admin` using only its own JWT context; with it, the same UPDATE raises
-- "You cannot change your own role" while benign self-edits (name/phone) still work.
--
-- A WITH CHECK alone cannot express this (it cannot compare NEW to OLD, and the
-- legitimate "edit my own name/phone" flow must keep working), so the enforcement
-- is a BEFORE UPDATE trigger that pins the privileged columns. A name-agnostic
-- WITH CHECK is added to the self-update policy as defense-in-depth.
-- ============================================================================

-- 1) Trigger: pin role / organization_id / id on UPDATE -----------------------
create or replace function public.guard_user_profile_privileged_columns()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor      uuid := auth.uid();
  actor_role text;
begin
  -- Trusted server-side code (service role / cron / auth signup triggers) carries
  -- no JWT → auth.uid() is NULL. Those paths are already privileged and create
  -- the first owner / invited members, so they must pass through unchanged.
  if actor is null then
    return new;
  end if;

  select role into actor_role
  from public.user_profiles
  where id = actor;

  -- (a) The id is the auth.users FK and must never move.
  if new.id is distinct from old.id then
    raise exception 'user_profiles.id is immutable';
  end if;

  -- (b) Nobody may change their OWN role or organization. Direct fix for the
  --     self-escalation vector.
  if actor = old.id then
    if new.role is distinct from old.role then
      raise exception 'You cannot change your own role';
    end if;
    if new.organization_id is distinct from old.organization_id then
      raise exception 'You cannot change your own organization';
    end if;
  end if;

  -- (c) Re-homing a user into a different tenant is never allowed through an
  --     authenticated UPDATE — blocks cross-tenant plants even by an org admin
  --     acting on another member. Org membership is set at invite/creation
  --     (service role, which short-circuits above).
  if new.organization_id is distinct from old.organization_id then
    raise exception 'Re-assigning a user to a different organization is not permitted';
  end if;

  -- (d) Only an agency_admin may grant the platform-level roles. Stops a practice
  --     admin (doctor_admin/office_manager/owner) from minting agency_admin/owner
  --     for anyone — the PostgREST-direct version of the team-management guard.
  if new.role is distinct from old.role
     and new.role in ('agency_admin', 'owner')
     and coalesce(actor_role, '') <> 'agency_admin' then
    raise exception 'Insufficient privilege to assign role %', new.role;
  end if;

  return new;
end;
$$;

drop trigger if exists guard_user_profile_privileged_columns on public.user_profiles;
create trigger guard_user_profile_privileged_columns
  before update on public.user_profiles
  for each row
  execute function public.guard_user_profile_privileged_columns();

-- 2) Defense-in-depth: add WITH CHECK to the self-update policy ----------------
-- Name-agnostic so it works regardless of which migration named the policy
-- (prod: user_profiles_update; source files: "Users can update their own
-- profile"). We only touch a permissive UPDATE policy whose USING already pins
-- the row to the caller (id = auth.uid()) and that currently has no WITH CHECK.
do $$
declare
  pol record;
begin
  for pol in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'user_profiles'
      and cmd        = 'UPDATE'
      and qual       = '(id = auth.uid())'
      and with_check is null
  loop
    execute format(
      'alter policy %I on public.user_profiles with check (id = auth.uid())',
      pol.policyname
    );
  end loop;
end $$;
