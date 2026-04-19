-- Migration 028: Phase 3 — Stripe payment ingestion
--
-- Adds:
--   1. stripe_payments — every payment_intent.succeeded / invoice.paid lands here.
--                        Linked to leads via email/phone match (best-effort).
--   2. stripe_webhook_events — append-only log of every webhook for replay/debugging
--   3. extends connector_configs.connector_type with 'stripe'
--
-- Brief: §4.2. Closes the gap where CareStack invoice sync lags actual money in.

-- ============================================
-- 1. STRIPE_PAYMENTS
-- ============================================
create table public.stripe_payments (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- Stripe identifiers
  stripe_event_id text not null,                -- 'evt_*' — used for idempotency
  stripe_object_id text not null,               -- the underlying object (pi_* | in_* | sub_*)
  stripe_object_type text not null
    check (stripe_object_type in ('payment_intent', 'invoice', 'subscription', 'charge', 'checkout_session')),
  stripe_customer_id text,
  stripe_account_id text,                       -- Connect platform; null for direct accounts

  -- Money (Stripe amounts are in the smallest currency unit — cents for USD)
  amount_cents integer not null,
  amount numeric(12,2) generated always as (amount_cents::numeric / 100) stored,
  currency text not null default 'USD',

  -- Customer match
  email text,
  email_hash text,
  phone text,
  phone_hash text,
  lead_id uuid references public.leads(id) on delete set null,
  patient_id uuid references public.patients(id) on delete set null,
  match_method text check (match_method in ('email_hash', 'phone_hash', 'manual', 'webhook_meta', 'unmatched')),

  -- Financing partner tagging (Sunbit, CareCredit, etc. — set as Stripe metadata)
  financing_partner text,

  -- Forwarder bookkeeping (one Purchase event per payment)
  forwarded boolean default false,
  forwarded_at timestamptz,

  status text,                                  -- 'succeeded' | 'paid' | 'active' | etc.
  occurred_at timestamptz not null,             -- when Stripe recorded the event
  metadata jsonb default '{}',                  -- stripe object metadata field
  raw_payload jsonb,                            -- full event for replay/debug

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index idx_stripe_payments_event_unique
  on public.stripe_payments(organization_id, stripe_event_id);
create index idx_stripe_payments_object on public.stripe_payments(organization_id, stripe_object_id);
create index idx_stripe_payments_customer on public.stripe_payments(organization_id, stripe_customer_id);
create index idx_stripe_payments_lead on public.stripe_payments(lead_id) where lead_id is not null;
create index idx_stripe_payments_pending_forward
  on public.stripe_payments(organization_id, occurred_at) where forwarded = false;
create index idx_stripe_payments_email_hash on public.stripe_payments(organization_id, email_hash) where email_hash is not null;

comment on table public.stripe_payments is 'Successful payments from Stripe, matched to leads/patients best-effort. Source of truth for paid revenue when CareStack invoice sync lags.';

-- ============================================
-- 2. STRIPE_WEBHOOK_EVENTS — append-only audit log
-- ============================================
create table public.stripe_webhook_events (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid references public.organizations(id) on delete cascade,
  stripe_event_id text not null,
  event_type text not null,                     -- 'payment_intent.succeeded' | etc.
  status text check (status in ('received', 'processed', 'ignored', 'failed')),
  error_message text,
  raw_payload jsonb,
  received_at timestamptz default now()
);

create index idx_stripe_webhook_events_event on public.stripe_webhook_events(stripe_event_id);
create index idx_stripe_webhook_events_org_received on public.stripe_webhook_events(organization_id, received_at desc);

-- ============================================
-- 3. EXTEND connector_configs FOR STRIPE
-- ============================================
alter table public.connector_configs drop constraint if exists connector_configs_connector_type_check;
alter table public.connector_configs add constraint connector_configs_connector_type_check
  check (connector_type in (
    'google_ads', 'meta_capi', 'ga4', 'outbound_webhook', 'slack', 'google_reviews', 'callrail',
    'cal_com', 'carestack', 'windsor', 'stripe'
  ));

-- ============================================
-- 4. updated_at TRIGGERS
-- ============================================
create trigger set_stripe_payments_updated_at
  before update on public.stripe_payments
  for each row execute function public.handle_updated_at();

-- ============================================
-- 5. RLS
-- ============================================
alter table public.stripe_payments enable row level security;
alter table public.stripe_webhook_events enable row level security;

create policy "Users view stripe_payments in their org"
  on public.stripe_payments for select using (organization_id = public.get_user_org_id());
create policy "Users view stripe_webhook_events in their org"
  on public.stripe_webhook_events for select using (organization_id = public.get_user_org_id());
