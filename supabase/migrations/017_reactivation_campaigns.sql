-- Migration 017: Reactivation Campaign Center
-- Dedicated tables for lead reactivation / nurturing / retargeting campaigns

-- ============================================
-- REACTIVATION CAMPAIGNS
-- ============================================
create table if not exists public.reactivation_campaigns (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid references public.campaigns(id) on delete set null,
  created_by uuid references public.user_profiles(id),

  name text not null,
  description text,

  -- Goal
  goal text not null default 're_engage'
    check (goal in ('re_engage', 'win_back', 'upsell', 'referral_ask')),

  -- AI Configuration
  tone text not null default 'empathetic'
    check (tone in ('empathetic', 'urgent', 'casual', 'professional')),
  ai_hooks jsonb default '[]',
    -- Array of hook strategy objects:
    -- [{ "strategy": "urgency", "enabled": true, "custom_text": null },
    --  { "strategy": "social_proof", "enabled": true, "custom_text": null }]

  -- Engagement Rules
  engagement_rules jsonb default '{
    "max_attempts": 5,
    "cooldown_days": 3,
    "escalation_strategy": "vary_channel",
    "stop_on_reply": true,
    "transition_to_live": true
  }',

  -- Channel preference
  channel text not null default 'multi'
    check (channel in ('sms', 'email', 'multi')),

  -- Status
  status text not null default 'draft'
    check (status in ('draft', 'active', 'paused', 'completed', 'archived')),

  -- Stats
  total_uploaded integer default 0,
  total_reactivated integer default 0,
  total_responded integer default 0,
  total_converted integer default 0,

  -- Upload metadata
  last_upload_at timestamptz,
  upload_count integer default 0,

  metadata jsonb default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_reactivation_campaigns_org
  on public.reactivation_campaigns(organization_id, status);

-- ============================================
-- REACTIVATION OFFERS (promos / incentives)
-- ============================================
create table if not exists public.reactivation_offers (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  reactivation_campaign_id uuid not null references public.reactivation_campaigns(id) on delete cascade,

  name text not null,
  description text,

  type text not null
    check (type in ('percentage_off', 'dollar_off', 'free_addon', 'financing_special', 'limited_time')),

  -- Value (interpretation depends on type)
  value numeric(10,2),                  -- e.g. 15.00 = 15% off or $15 off
  expiry_date timestamptz,              -- when the offer expires
  usage_limit integer,                  -- max number of redemptions
  times_used integer default 0,

  is_active boolean default true,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_reactivation_offers_campaign
  on public.reactivation_offers(reactivation_campaign_id);

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================
alter table public.reactivation_campaigns enable row level security;
alter table public.reactivation_offers enable row level security;

create policy "Users can view reactivation campaigns in their org"
  on public.reactivation_campaigns for select
  using (organization_id = public.get_user_org_id());

create policy "Users can manage reactivation campaigns in their org"
  on public.reactivation_campaigns for all
  using (organization_id = public.get_user_org_id());

create policy "Users can view reactivation offers in their org"
  on public.reactivation_offers for select
  using (organization_id = public.get_user_org_id());

create policy "Users can manage reactivation offers in their org"
  on public.reactivation_offers for all
  using (organization_id = public.get_user_org_id());

-- ============================================
-- TRIGGERS
-- ============================================
create trigger set_reactivation_campaigns_updated_at
  before update on public.reactivation_campaigns
  for each row execute function public.handle_updated_at();

create trigger set_reactivation_offers_updated_at
  before update on public.reactivation_offers
  for each row execute function public.handle_updated_at();
