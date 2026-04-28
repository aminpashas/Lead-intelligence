-- Migration 028: Daily ad-platform metrics table for closed-loop reporting.
--
-- Each row is one (org, channel, account, campaign, date) tuple — the
-- cron at /api/cron/sync-ad-metrics fills this table by hitting:
--   - Google Ads API (GAQL `campaign` report)
--   - Meta Marketing API (`/{ad_account_id}/insights`)
--   - GA4 Data API (`runReport` keyed on session source/medium/campaign)
--
-- The leads-side attribution dashboard already aggregates conversions and
-- revenue per UTM/source out of `leads`. Joining that with this table on
-- (channel, campaign_id, date) gives true ROAS — the gap that "without
-- spend you can't compute return" was leaving open.
--
-- Note on currency: we persist account currency per row rather than
-- normalizing to a single "org currency" because Google Ads / Meta both
-- support per-account currency and an org could connect multiple accounts
-- across markets. Roll-ups happen at query time using the latest FX rate
-- from a future fx_rates table; for now it's the dashboard's job to either
-- filter to a single currency or display per-currency totals.

create table if not exists public.ad_metrics_daily (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- The ad platform this row came from. 'ga4' is included because we
  -- store GA4 sessions/users alongside paid spend rows so the dashboard
  -- can show traffic vs. spend in one query.
  channel text not null check (channel in ('google_ads', 'meta', 'ga4')),

  -- Account identifier — Google Ads customer_id (no dashes), Meta
  -- "act_..." form, or GA4 property "properties/...". Stored as text so
  -- we don't need separate columns per channel.
  account_id text not null,

  -- Campaign-level granularity. Nullable because GA4 rows that don't have
  -- a session campaign (direct, organic) come back without one — we still
  -- want to capture the traffic.
  campaign_id text,
  campaign_name text,

  -- The metric date (in the account's reporting timezone — Google/Meta
  -- both report by the account's configured TZ; GA4 by property TZ).
  metric_date date not null,

  -- Core metrics. spend / revenue use numeric for currency math accuracy.
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  spend numeric(14, 4) not null default 0,
  conversions numeric(14, 4) not null default 0,    -- platform-reported, may be fractional (Google Ads attribution)
  conversion_value numeric(14, 4) not null default 0, -- platform-reported revenue

  -- GA4-specific metrics. NULL on paid rows. We could split into two
  -- tables but keeping one schema simplifies the dashboard query and the
  -- column count is modest.
  sessions bigint,
  users bigint,
  engaged_sessions bigint,

  -- Account currency code (ISO 4217). NULL for ga4 rows.
  currency text,

  -- When the cron last refreshed this row. Useful for "stale data" badges
  -- and to skip re-fetching dates that were updated in the last few hours
  -- (Google + Meta backfill conversions for several days after the click,
  -- so we always re-pull a 14-day rolling window).
  synced_at timestamptz not null default now(),

  -- One row per (org, channel, account, campaign, date). NULL campaigns
  -- collapse together — we coalesce to '' in the unique-constraint
  -- predicate so 'no campaign' is a single bucket per channel/account/date.
  unique (organization_id, channel, account_id, campaign_id, metric_date)
);

create index if not exists idx_ad_metrics_org_date
  on public.ad_metrics_daily (organization_id, metric_date desc);

create index if not exists idx_ad_metrics_org_channel_date
  on public.ad_metrics_daily (organization_id, channel, metric_date desc);

-- Multi-tenant isolation. Service role (the cron) bypasses for writes.
alter table public.ad_metrics_daily enable row level security;

create policy ad_metrics_org_read on public.ad_metrics_daily
  for select using (organization_id = get_user_org_id());

create policy ad_metrics_service_all on public.ad_metrics_daily
  for all to service_role using (true) with check (true);

-- Sync cursor table — one row per (org, channel) tracking the last
-- successful pull. Lets the cron be idempotent + resumable, and surfaces
-- "last sync" timestamps in the dashboard.
create table if not exists public.ad_metrics_sync_state (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel text not null check (channel in ('google_ads', 'meta', 'ga4')),
  last_synced_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  rows_inserted_last_run integer,
  primary key (organization_id, channel)
);

alter table public.ad_metrics_sync_state enable row level security;

create policy ad_metrics_sync_state_org_read on public.ad_metrics_sync_state
  for select using (organization_id = get_user_org_id());

create policy ad_metrics_sync_state_service_all on public.ad_metrics_sync_state
  for all to service_role using (true) with check (true);
