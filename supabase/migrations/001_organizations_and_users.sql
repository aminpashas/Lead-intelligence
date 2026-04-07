-- Migration 001: Organizations and Users
-- Multi-tenant foundation for Lead Intelligence CRM

-- Enable required extensions
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ============================================
-- ORGANIZATIONS (dental practices)
-- ============================================
create table public.organizations (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  slug text unique not null,
  logo_url text,
  website text,
  phone text,
  email text,
  address jsonb, -- {street, city, state, zip, country}
  settings jsonb default '{}', -- practice-level settings
  subscription_tier text default 'trial' check (subscription_tier in ('trial', 'starter', 'professional', 'enterprise')),
  subscription_status text default 'active' check (subscription_status in ('active', 'past_due', 'canceled', 'trialing')),
  trial_ends_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================
-- USER PROFILES (practice staff)
-- ============================================
create table public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  full_name text not null,
  email text not null,
  avatar_url text,
  role text not null default 'member' check (role in ('owner', 'admin', 'manager', 'member')),
  is_active boolean default true,
  last_seen_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_user_profiles_org on public.user_profiles(organization_id);

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================
alter table public.organizations enable row level security;
alter table public.user_profiles enable row level security;

-- Organization policies
create policy "Users can view their own organization"
  on public.organizations for select
  using (id in (select organization_id from public.user_profiles where id = auth.uid()));

create policy "Owners can update their organization"
  on public.organizations for update
  using (id in (select organization_id from public.user_profiles where id = auth.uid() and role = 'owner'));

-- User profile policies
create policy "Users can view profiles in their organization"
  on public.user_profiles for select
  using (organization_id in (select organization_id from public.user_profiles where id = auth.uid()));

create policy "Users can update their own profile"
  on public.user_profiles for update
  using (id = auth.uid());

create policy "Admins can manage user profiles"
  on public.user_profiles for all
  using (organization_id in (select organization_id from public.user_profiles where id = auth.uid() and role in ('owner', 'admin')));

-- ============================================
-- HELPER FUNCTIONS
-- ============================================
create or replace function public.get_user_org_id()
returns uuid
language sql
stable
security definer
as $$
  select organization_id from public.user_profiles where id = auth.uid() limit 1;
$$;

-- Auto-update updated_at
create or replace function public.handle_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger set_organizations_updated_at
  before update on public.organizations
  for each row execute function public.handle_updated_at();

create trigger set_user_profiles_updated_at
  before update on public.user_profiles
  for each row execute function public.handle_updated_at();
