-- Invite-aware signup: land invited team members in the right org/role without
-- creating a stray "My Practice" organization.
--
-- Problem: `handle_auth_user_created` fired on EVERY auth.users insert and
-- unconditionally spun up a new org + `owner` profile. Correct for self-serve
-- signup, wrong for an INVITED member (stray org, wrong org, wrong role). Those
-- stray orgs can't even be cleaned up — `audit_events` is append-only (WORM) and
-- its org FK is ON DELETE CASCADE, so deleting the org is rejected.
--
-- Why not app_metadata / user_metadata? `admin.createUser` writes app_metadata
-- AFTER the row insert, so the AFTER-INSERT trigger never sees it. user_metadata
-- IS visible at insert but is client-settable on public signUp, so trusting it
-- for org/role placement would be a cross-tenant privilege-escalation hole.
--
-- Fix: a server-only staging table. `provisionMember` (service role) writes a
-- `pending_team_invites` row, then creates the auth user; the trigger looks the
-- invite up BY EMAIL, places the profile in that existing org with the assigned
-- role, and consumes the row. RLS denies all non-service access, so a public
-- signup can neither create nor read an invite — the branch is safe to trust.

create table if not exists public.pending_team_invites (
  email            text primary key,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  role             text not null,
  invited_by       uuid references public.user_profiles(id) on delete set null,
  created_at       timestamptz not null default now()
);

-- RLS on, NO policies → only the service role (which bypasses RLS) can touch it.
alter table public.pending_team_invites enable row level security;

create or replace function public.handle_auth_user_created()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_org_id uuid;
  v_slug text;
  v_practice_name text;
  v_full_name text;
  v_invite public.pending_team_invites%rowtype;
begin
  v_full_name := coalesce(new.raw_user_meta_data->>'full_name', 'User');

  -- Invited team member? Match a server-staged invite by email. Only the
  -- service role can have written this row, so it's safe to trust.
  select * into v_invite
  from public.pending_team_invites
  where email = lower(new.email);

  if found then
    insert into public.user_profiles (id, organization_id, full_name, email, role, invited_by, invited_at)
    values (new.id, v_invite.organization_id, v_full_name, new.email, v_invite.role, v_invite.invited_by, now());
    delete from public.pending_team_invites where email = v_invite.email;
    return new;
  end if;

  -- Self-serve signup: provision a fresh organization + owner profile (unchanged).
  v_practice_name := coalesce(new.raw_user_meta_data->>'practice_name', 'My Practice');
  v_slug := lower(regexp_replace(v_practice_name, '[^a-zA-Z0-9]+', '-', 'g'));
  v_slug := trim(both '-' from v_slug);
  v_slug := v_slug || '-' || substr(md5(random()::text), 1, 6);

  insert into public.organizations (name, slug, email)
  values (v_practice_name, v_slug, new.email)
  returning id into v_org_id;

  insert into public.user_profiles (id, organization_id, full_name, email, role)
  values (new.id, v_org_id, v_full_name, new.email, 'owner');

  return new;
end;
$function$;
