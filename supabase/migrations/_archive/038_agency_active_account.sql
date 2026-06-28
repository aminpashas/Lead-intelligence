-- Migration 038: Agency Active Account ("Enter Account")
--
-- Lets an agency_admin drop into a specific client organization and operate
-- the whole app as that client. The selection is stored per agency-admin user
-- in `agency_active_org`, and `get_user_org_id()` is taught to honor it.
--
-- Because virtually every RLS policy in the schema resolves tenancy through
-- get_user_org_id(), this single function change scopes leads, conversations,
-- connectors, etc. to the selected client with no per-table changes. The
-- selection IS the access grant — and it is honored ONLY when the caller is an
-- agency_admin, so a stray row can never let a normal user cross tenants.

-- ============================================
-- 1. ACTIVE ACCOUNT TABLE
-- One row per agency admin = the client org they are currently "inside".
-- No row = they are at the agency console / their own home org.
-- ============================================
create table if not exists public.agency_active_org (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  active_org_id  uuid not null references public.organizations(id) on delete cascade,
  updated_at     timestamptz not null default now()
);

create index if not exists idx_agency_active_org_org
  on public.agency_active_org (active_org_id);

-- ============================================
-- 2. CONTEXT-AWARE get_user_org_id()
-- Agency admins with an active selection resolve to that client org;
-- everyone else (and agency admins with no selection) resolve to their
-- own profile's organization_id, exactly as before.
-- ============================================
create or replace function public.get_user_org_id()
returns uuid
language sql
stable
security definer
-- Pin search_path: this SECURITY DEFINER function is the basis of all tenant
-- isolation, so an unpinned path would let a caller shadow user_profiles /
-- agency_active_org via a temp schema. (Remediates advisor lint 0011.)
set search_path = public, pg_temp
as $$
  select coalesce(
    -- Agency admin acting inside a client account. The role guard lives in
    -- the join so the override only applies to genuine agency admins.
    (
      select a.active_org_id
      from public.agency_active_org a
      join public.user_profiles p on p.id = a.user_id
      where a.user_id = auth.uid()
        and p.role = 'agency_admin'
    ),
    -- Default: the user's own home organization.
    (select organization_id from public.user_profiles where id = auth.uid())
  );
$$;

-- ============================================
-- 3. RLS — agency admins manage only their own active-account row
-- ============================================
alter table public.agency_active_org enable row level security;

drop policy if exists agency_active_org_self on public.agency_active_org;
create policy agency_active_org_self on public.agency_active_org
  for all
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.user_profiles
      where id = auth.uid() and role = 'agency_admin'
    )
  );

-- Service role bypass (server actions / cron), matches connector tables.
drop policy if exists agency_active_org_service on public.agency_active_org;
create policy agency_active_org_service on public.agency_active_org
  for all to service_role using (true) with check (true);

-- Keep updated_at fresh.
drop trigger if exists set_agency_active_org_updated_at on public.agency_active_org;
create trigger set_agency_active_org_updated_at
  before update on public.agency_active_org
  for each row execute function public.handle_updated_at();
