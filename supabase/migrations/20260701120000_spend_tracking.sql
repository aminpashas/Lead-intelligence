-- Migration: Spend tracking + client re-billing
--
-- Adds a single billable ledger for non-AI services and per-practice markup config so the
-- agency can (a) see blended cost across Anthropic + Twilio SMS + Retell voice and
-- (b) re-bill each practice at cost + markup.
--
--   1. cost_events      — one row per billable SMS / voice / email event.
--                         cost_cents = what WE pay; billable_cents = what we charge the practice.
--                         Written "estimated" at send time, reconciled to "final" from the
--                         provider's real price on the status/completed webhook.
--   2. billing_settings — per-practice markup (%) per service + optional flat monthly platform fee.
--   3. ai_usage         — extend with cache-token columns + billable_cents (AI keeps its own
--                         ledger so the per-lead budget cap in usage.ts is untouched).
--   4. RLS              — org members see their own rows; agency admins see ALL practices'
--                         (the existing ai_usage policy was org-only, so the agency spend
--                         dashboard would have rendered zeros without this).
--
-- Money is US cents, numeric(_,4) — fractional cents are preserved and rounded only at
-- invoice/display aggregation. Provider figures are always reconciled against the real invoice.

-- ============================================================
-- 1. cost_events — SMS / voice / email billable ledger
-- ============================================================
create table if not exists public.cost_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  service text not null check (service in ('sms', 'voice', 'email')),
  status text not null default 'estimated' check (status in ('estimated', 'final')),
  event_at timestamptz not null default now(),

  -- Linkage to the source record + the provider's id (for idempotent reconciliation)
  source_table text,                         -- 'messages' | 'voice_calls'
  source_id uuid,
  external_id text,                          -- Twilio message SID / Retell call id

  -- Quantity in the service's natural unit
  quantity numeric(14,4),                    -- segments (sms) / seconds (voice)
  unit text,                                 -- 'segments' | 'seconds'

  -- Money (US cents; fractional preserved)
  cost_cents numeric(12,4) not null default 0,      -- what WE pay the provider
  billable_cents numeric(12,4) not null default 0,  -- what we charge the practice (cost + markup)
  markup_pct numeric(6,2),                          -- markup snapshot applied at event time

  metadata jsonb default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idempotent reconciliation: estimate→final and webhook retries upsert by the provider id.
-- Deliberately NOT a partial index — a partial unique index cannot serve as an ON CONFLICT
-- target in PostgREST upserts. Postgres treats NULLs as distinct, so non-null (service,
-- external_id) pairs stay unique while rows without a provider id are still allowed.
create unique index if not exists idx_cost_events_service_external
  on public.cost_events(service, external_id);

create index if not exists idx_cost_events_org_event_at
  on public.cost_events(organization_id, event_at desc);
create index if not exists idx_cost_events_org_service
  on public.cost_events(organization_id, service, event_at desc);

comment on table public.cost_events is
  'Billable ledger for SMS/voice/email. cost_cents = provider cost, billable_cents = re-billed to the practice at cost+markup. Estimated at send, reconciled to final from provider price. AI usage lives in ai_usage.';

-- ============================================================
-- 2. billing_settings — per-practice re-bill config
-- ============================================================
create table if not exists public.billing_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  -- Per-service markup percentages, e.g. {"ai": 50, "sms": 40, "voice": 30, "email": 40}.
  -- An empty object means "use platform defaults" (see src/lib/billing/markup.ts).
  markups jsonb not null default '{}'::jsonb,
  -- Optional flat monthly platform fee, applied at invoice aggregation (not per event).
  platform_fee_cents integer not null default 0,
  notes text,
  updated_at timestamptz not null default now()
);

comment on table public.billing_settings is
  'Per-practice re-billing config: markup % per service (jsonb) + optional flat monthly platform fee. Empty markups = platform defaults.';

-- ============================================================
-- 3. Extend ai_usage — cache tokens + billable snapshot
-- ============================================================
alter table public.ai_usage add column if not exists cache_read_tokens integer not null default 0;
alter table public.ai_usage add column if not exists cache_write_tokens integer not null default 0;
alter table public.ai_usage add column if not exists billable_cents numeric(10,4) not null default 0;

comment on column public.ai_usage.cache_read_tokens is 'Anthropic cache_read_input_tokens (billed ≈ 0.1× input).';
comment on column public.ai_usage.cache_write_tokens is 'Anthropic cache_creation_input_tokens (billed ≈ 1.25× input).';
comment on column public.ai_usage.billable_cents is 'Re-billed amount = cost_cents × (1 + AI markup), snapshotted at write time.';

-- ============================================================
-- 4. RLS
-- ============================================================
alter table public.cost_events enable row level security;
alter table public.billing_settings enable row level security;

-- cost_events: org members see their own; agency admins see all. Writes are service-role only.
drop policy if exists "Users can view cost_events in their org" on public.cost_events;
create policy "Users can view cost_events in their org"
  on public.cost_events for select
  using (organization_id = public.get_user_org_id());

drop policy if exists "Agency admins can view all cost_events" on public.cost_events;
create policy "Agency admins can view all cost_events"
  on public.cost_events for select
  using (public.is_agency_admin());

-- billing_settings: org members read their own; agency admins read + write everyone's.
drop policy if exists "View billing settings" on public.billing_settings;
create policy "View billing settings"
  on public.billing_settings for select
  using (organization_id = public.get_user_org_id() or public.is_agency_admin());

drop policy if exists "Agency admins manage billing settings" on public.billing_settings;
create policy "Agency admins manage billing settings"
  on public.billing_settings for all
  using (public.is_agency_admin())
  with check (public.is_agency_admin());

-- ai_usage: the existing SELECT policy is org-only, so an agency admin (whose org is the
-- agency's own home org) would see none of the practices' AI usage. Widen it for the dashboard.
drop policy if exists "Agency admins can view all ai_usage" on public.ai_usage;
create policy "Agency admins can view all ai_usage"
  on public.ai_usage for select
  using (public.is_agency_admin());

-- ============================================================
-- 5. updated_at triggers
-- ============================================================
drop trigger if exists set_cost_events_updated_at on public.cost_events;
create trigger set_cost_events_updated_at
  before update on public.cost_events
  for each row execute function public.handle_updated_at();

drop trigger if exists set_billing_settings_updated_at on public.billing_settings;
create trigger set_billing_settings_updated_at
  before update on public.billing_settings
  for each row execute function public.handle_updated_at();
