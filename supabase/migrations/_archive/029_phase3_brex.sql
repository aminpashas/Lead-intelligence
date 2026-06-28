-- Migration 029: Phase 3 — Brex expense ingestion (fully-loaded CAC)
--
-- Adds:
--   1. expense_line_items   — every Brex transaction, auto-categorized by vendor
--   2. brex_sync_state      — per-org cursor for incremental pull
--   3. extends connector_configs.connector_type with 'brex'
--
-- Categories drive the dashboard's true-CAC math:
--   acquisition  → Google Ads, Meta Ads, agency fees (DDS Marketing, etc.)
--   platform     → Twilio, Resend, Retell, Cal.com, Vercel, Supabase, Anthropic, CareStack, Stripe
--   other        → everything else (operating costs that don't load into CAC)
--
-- Brief: §4.4.

-- ============================================
-- 1. EXPENSE_LINE_ITEMS
-- ============================================
create table public.expense_line_items (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  source text not null default 'brex' check (source in ('brex', 'manual')),
  external_id text not null,                    -- Brex transaction id
  posted_at timestamptz not null,

  amount_cents integer not null,                -- Brex amounts are in cents
  amount numeric(12,2) generated always as (amount_cents::numeric / 100) stored,
  currency text not null default 'USD',

  vendor_name text,                             -- raw merchant name from Brex
  vendor_normalized text,                       -- lowercased, deduped
  description text,
  card_last4 text,
  user_email text,

  -- Auto-categorization (see categorize.ts). Staff can override.
  category text not null default 'other'
    check (category in ('acquisition', 'platform', 'other')),
  subcategory text,                             -- 'google_ads' | 'meta_ads' | 'agency_dds' | 'twilio' | etc.
  category_overridden boolean default false,    -- true if staff manually re-categorized

  metadata jsonb default '{}',
  raw_payload jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index idx_expense_line_items_unique
  on public.expense_line_items(organization_id, source, external_id);
create index idx_expense_line_items_org_posted on public.expense_line_items(organization_id, posted_at desc);
create index idx_expense_line_items_org_category on public.expense_line_items(organization_id, category, posted_at desc);
create index idx_expense_line_items_vendor on public.expense_line_items(organization_id, vendor_normalized) where vendor_normalized is not null;

comment on table public.expense_line_items is 'Brex transactions, auto-categorized into acquisition/platform/other for fully-loaded CAC. Staff can override category via the dashboard.';

-- ============================================
-- 2. BREX_SYNC_STATE — per-org cursor
-- ============================================
create table public.brex_sync_state (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  last_synced_posted_at timestamptz,            -- watermark from the most recent successful pull
  last_run_at timestamptz,
  last_run_status text check (last_run_status in ('success', 'partial', 'failed')),
  last_run_count integer,
  last_run_error text,

  metadata jsonb default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index idx_brex_sync_state_org on public.brex_sync_state(organization_id);

-- ============================================
-- 3. EXTEND connector_configs FOR BREX
-- ============================================
alter table public.connector_configs drop constraint if exists connector_configs_connector_type_check;
alter table public.connector_configs add constraint connector_configs_connector_type_check
  check (connector_type in (
    'google_ads', 'meta_capi', 'ga4', 'outbound_webhook', 'slack', 'google_reviews', 'callrail',
    'cal_com', 'carestack', 'windsor', 'stripe', 'brex'
  ));

-- ============================================
-- 4. updated_at TRIGGERS
-- ============================================
create trigger set_expense_line_items_updated_at
  before update on public.expense_line_items
  for each row execute function public.handle_updated_at();
create trigger set_brex_sync_state_updated_at
  before update on public.brex_sync_state
  for each row execute function public.handle_updated_at();

-- ============================================
-- 5. RLS
-- ============================================
alter table public.expense_line_items enable row level security;
alter table public.brex_sync_state enable row level security;

create policy "Users view expense_line_items in their org"
  on public.expense_line_items for select using (organization_id = public.get_user_org_id());
create policy "Users update expense_line_items in their org (for category override)"
  on public.expense_line_items for update using (organization_id = public.get_user_org_id());
create policy "Users view brex_sync_state in their org"
  on public.brex_sync_state for select using (organization_id = public.get_user_org_id());
