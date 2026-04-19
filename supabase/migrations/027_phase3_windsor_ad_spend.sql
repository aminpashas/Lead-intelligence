-- Migration 027: Phase 3 — Windsor.ai ad spend ingestion
--
-- Adds:
--   1. ad_spend_daily   — per-day, per-platform, per-campaign spend / impressions / clicks / leads
--   2. windsor_sync_state — per-org cursor (last_synced_date) for daily polling
--   3. extends connector_configs.connector_type with 'windsor'
--
-- Brief reference: Section 4.3 (Windsor.ai). Closes the CAC side of the equation.

-- ============================================
-- 1. AD_SPEND_DAILY — daily roll-up
-- ============================================
create table public.ad_spend_daily (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  date date not null,
  platform text not null check (platform in ('google_ads', 'meta_ads', 'tiktok_ads', 'youtube_ads', 'linkedin_ads', 'other')),

  -- Identifiers — used to JOIN against leads.utm_campaign / leads.utm_source / etc.
  account_id text,                          -- Windsor account_id (the platform's account)
  account_name text,
  campaign_id text,
  campaign_name text,
  ad_group_id text,
  ad_group_name text,

  -- Metrics (all currency in USD; convert in Windsor side if needed)
  spend numeric(12,2) not null default 0,
  impressions integer not null default 0,
  clicks integer not null default 0,
  conversions numeric(12,2) default 0,      -- Windsor reports may emit fractional from value-based bidding
  conversion_value numeric(12,2) default 0, -- platform-reported revenue (we use OUR revenue from events table for ROAS)

  -- Convenience precomputes
  cpc numeric(10,4),                        -- spend / clicks
  cpm numeric(10,4),                        -- 1000 * spend / impressions
  ctr numeric(6,4),                         -- clicks / impressions

  metadata jsonb default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Idempotency key: upsert on (org, date, platform, campaign_id|null, ad_group_id|null).
-- We use coalesce-via-empty-string so the unique index works on null values too.
create unique index idx_ad_spend_daily_unique
  on public.ad_spend_daily(
    organization_id,
    date,
    platform,
    coalesce(campaign_id, ''),
    coalesce(ad_group_id, '')
  );

create index idx_ad_spend_daily_org_date on public.ad_spend_daily(organization_id, date desc);
create index idx_ad_spend_daily_org_campaign on public.ad_spend_daily(organization_id, campaign_name) where campaign_name is not null;
create index idx_ad_spend_daily_org_platform_date on public.ad_spend_daily(organization_id, platform, date desc);

comment on table public.ad_spend_daily is 'Daily ad spend roll-up pulled from Windsor.ai. JOINs against leads.utm_campaign / utm_source for per-campaign CAC + against treatment_procedures / invoices for ROAS.';

-- ============================================
-- 2. WINDSOR_SYNC_STATE — per-org cursor
-- ============================================
create table public.windsor_sync_state (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  last_synced_date date,                    -- most recent date we successfully ingested
  last_run_at timestamptz,
  last_run_status text check (last_run_status in ('success', 'partial', 'failed')),
  last_run_rows integer,
  last_run_error text,

  metadata jsonb default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index idx_windsor_sync_state_org on public.windsor_sync_state(organization_id);

-- ============================================
-- 3. EXTEND connector_configs FOR WINDSOR
-- ============================================
alter table public.connector_configs drop constraint if exists connector_configs_connector_type_check;
alter table public.connector_configs add constraint connector_configs_connector_type_check
  check (connector_type in (
    'google_ads', 'meta_capi', 'ga4', 'outbound_webhook', 'slack', 'google_reviews', 'callrail',
    'cal_com', 'carestack', 'windsor'
  ));

-- ============================================
-- 4. updated_at TRIGGERS
-- ============================================
create trigger set_ad_spend_daily_updated_at
  before update on public.ad_spend_daily
  for each row execute function public.handle_updated_at();
create trigger set_windsor_sync_state_updated_at
  before update on public.windsor_sync_state
  for each row execute function public.handle_updated_at();

-- ============================================
-- 5. RLS
-- ============================================
alter table public.ad_spend_daily enable row level security;
alter table public.windsor_sync_state enable row level security;

create policy "Users view ad_spend_daily in their org"
  on public.ad_spend_daily for select using (organization_id = public.get_user_org_id());
create policy "Users view windsor_sync_state in their org"
  on public.windsor_sync_state for select using (organization_id = public.get_user_org_id());
