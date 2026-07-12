-- Workstream B2: widened enrichment attribute store (~200 attributes).
--
-- WHAT: adds a namespaced jsonb attribute map to lead_enrichment so every
-- provider can persist its FULL payload (email.*, phone.*, geo.*, ads.*,
-- web.*, experian.*) instead of the handful of cherry-picked typed columns,
-- plus a few high-value typed columns on leads sourced from Experian
-- ConsumerView.
--
-- FCRA NOTE: everything stored here is MARKETING data (Experian ConsumerView
-- is a non-FCRA marketing database; no credit pull occurs). None of these
-- columns or attribute keys may be used as inputs to credit/financing
-- ELIGIBILITY decisions. Enforced by src/lib/enrichment/__tests__/
-- fcra-guardrail.test.ts.

-- ============================================
-- 1. Namespaced attribute map on lead_enrichment
-- ============================================
alter table public.lead_enrichment
  add column if not exists enrichment_attributes jsonb not null default '{}'::jsonb;

comment on column public.lead_enrichment.enrichment_attributes is
  'Namespaced provider attributes (email.*, phone.*, geo.*, ads.*, web.*, experian.*). Marketing/operational data only — MUST NOT feed credit or financing eligibility logic (FCRA).';

create index if not exists idx_enrichment_attributes_gin
  on public.lead_enrichment using gin (enrichment_attributes);

-- ============================================
-- 2. Allow the new experian_consumer enrichment type
-- ============================================
alter table public.lead_enrichment
  drop constraint if exists lead_enrichment_enrichment_type_check;

alter table public.lead_enrichment
  add constraint lead_enrichment_enrichment_type_check check (enrichment_type in (
    'email_validation', 'phone_validation', 'ip_geolocation',
    'google_ads_keyword', 'website_behavior', 'credit_prequal',
    'experian_consumer'
  ));

-- ============================================
-- 3. Typed marketing-data columns on leads (Experian-derived)
--    Verified absent from prior migrations before adding.
-- ============================================
alter table public.leads
  add column if not exists household_income_band text,
  add column if not exists homeowner_status text,
  add column if not exists home_value_band text,
  add column if not exists mosaic_segment text;

comment on column public.leads.household_income_band is
  'Marketing data (Experian ConsumerView estimated household income band, e.g. "75000-100000"). NOT credit data; must not feed financing eligibility (FCRA).';
comment on column public.leads.homeowner_status is
  'Marketing data (Experian ConsumerView): homeowner | renter. NOT credit data; must not feed financing eligibility (FCRA).';
comment on column public.leads.home_value_band is
  'Marketing data (Experian ConsumerView estimated home value band, e.g. "300000-400000"). NOT credit data; must not feed financing eligibility (FCRA).';
comment on column public.leads.mosaic_segment is
  'Marketing data (Experian Mosaic lifestyle segment, e.g. "A01"). NOT credit data; must not feed financing eligibility (FCRA).';
