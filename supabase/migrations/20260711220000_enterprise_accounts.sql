-- Migration: Enterprise Accounts (DSO umbrella)
--
-- Models the real customer shape for onboarding + pricing: each physical LOCATION
-- is its own account with its own pricing (an `organizations` row, as today), and a
-- customer may own many locations (a DSO with 40 offices) grouped under ONE
-- enterprise account for centralized admin + rolled-up reporting.
--
-- Purely additive and low-risk:
--   * `enterprise_accounts` is a new grouping table.
--   * `organizations.enterprise_account_id` is a NULLABLE FK — standalone practices
--     (every org today) keep it NULL and are wholly unaffected.
--   * No `get_user_org_id()` change and no child-table RLS change: agency admins
--     already see/enter every org (migration 018), so grouping them adds no new
--     tenancy path. Billing/pricing stay strictly per-org (per the product decision:
--     per-location independent billing; enterprise is an admin/reporting umbrella only).

-- ============================================
-- 1. ENTERPRISE ACCOUNTS (the umbrella grouping)
-- ============================================
create table if not exists public.enterprise_accounts (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text unique not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================
-- 2. LINK: each location (org) optionally belongs to one enterprise
-- NULLABLE + `on delete set null` so deleting an enterprise never cascades into
-- deleting locations; the locations simply become standalone again.
-- ============================================
alter table public.organizations
  add column if not exists enterprise_account_id uuid
    references public.enterprise_accounts(id) on delete set null;

create index if not exists idx_organizations_enterprise
  on public.organizations(enterprise_account_id);

-- ============================================
-- 3. RLS — agency-admin owned, exactly like the rest of the agency layer
-- Enterprises are a Dion-side construct: only agency admins create/manage them.
-- Reuses is_agency_admin() (migration 018). Service role bypass for server jobs.
-- ============================================
alter table public.enterprise_accounts enable row level security;

drop policy if exists enterprise_accounts_agency on public.enterprise_accounts;
create policy enterprise_accounts_agency on public.enterprise_accounts
  for all
  using (public.is_agency_admin())
  with check (public.is_agency_admin());

drop policy if exists enterprise_accounts_service on public.enterprise_accounts;
create policy enterprise_accounts_service on public.enterprise_accounts
  for all to service_role
  using (true) with check (true);

-- Keep updated_at fresh (shared trigger fn from migration 001).
drop trigger if exists set_enterprise_accounts_updated_at on public.enterprise_accounts;
create trigger set_enterprise_accounts_updated_at
  before update on public.enterprise_accounts
  for each row execute function public.handle_updated_at();

comment on table public.enterprise_accounts is
  'DSO/enterprise umbrella grouping N locations (organizations). Admin + reporting only — '
  'billing/pricing remain per-location on organizations/billing_settings. Agency-admin managed.';
comment on column public.organizations.enterprise_account_id is
  'Optional parent enterprise (DSO). NULL = standalone single-location practice.';
