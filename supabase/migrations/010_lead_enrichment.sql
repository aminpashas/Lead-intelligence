-- Migration 010: Lead Enrichment System
-- Adds third-party enrichment pipeline for lead qualification

-- ============================================
-- LEAD ENRICHMENT TABLE
-- ============================================
create table if not exists public.lead_enrichment (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,

  enrichment_type text not null check (enrichment_type in (
    'email_validation', 'phone_validation', 'ip_geolocation',
    'google_ads_keyword', 'website_behavior', 'credit_prequal'
  )),
  enrichment_source text not null,
  status text not null default 'pending' check (status in ('pending', 'success', 'failed', 'skipped')),
  data jsonb not null default '{}',
  error_message text,
  confidence_score numeric(3,2) check (confidence_score >= 0 and confidence_score <= 1),
  enriched_at timestamptz default now(),
  expires_at timestamptz,
  created_at timestamptz default now()
);

-- Indexes
create index idx_enrichment_lead on public.lead_enrichment(lead_id, enrichment_type);
create index idx_enrichment_org on public.lead_enrichment(organization_id, enrichment_type);
create index idx_enrichment_org_status on public.lead_enrichment(organization_id, status)
  where status = 'pending';

-- ============================================
-- ADD ENRICHMENT FIELDS TO LEADS TABLE
-- ============================================
alter table public.leads
  add column if not exists enrichment_score integer default 0,
  add column if not exists enrichment_status text default 'pending',
  add column if not exists enriched_at timestamptz,
  add column if not exists email_valid boolean,
  add column if not exists phone_valid boolean,
  add column if not exists phone_line_type text,
  add column if not exists ip_address text,
  add column if not exists ip_city text,
  add column if not exists ip_region text,
  add column if not exists ip_country text,
  add column if not exists distance_to_practice_miles numeric(8,1);

create index if not exists idx_leads_enrichment_status on public.leads(organization_id, enrichment_status)
  where enrichment_status in ('pending', 'partial');

-- ============================================
-- RLS POLICIES
-- ============================================
alter table public.lead_enrichment enable row level security;

create policy "Users can view enrichment in their org"
  on public.lead_enrichment for select
  using (organization_id = public.get_user_org_id());

create policy "Users can create enrichment in their org"
  on public.lead_enrichment for insert
  with check (organization_id = public.get_user_org_id());

-- Service role can do everything (for webhooks/cron)
create policy "Service role full access"
  on public.lead_enrichment for all
  using (true)
  with check (true);
