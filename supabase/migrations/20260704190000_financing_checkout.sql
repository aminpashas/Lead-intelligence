-- ═══════════════════════════════════════════════════════════════
-- Patient financing checkout — stacked-plan sessions + per-lender sub-apps
-- ═══════════════════════════════════════════════════════════════
-- A checkout session is a chosen stacked plan the patient proceeds with. Because
-- most lenders send their application link directly to the patient and each is
-- completed off-site over days, a session holds N per-lender sub-applications,
-- each a small state machine. The resume_token is DURABLE/reusable (unlike the
-- 24h prequal link) so patient + staff can "pick back up" the process anytime.
--
-- GATED: not auto-applied. A human applies via the project migration process.

create table if not exists public.financing_checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  treatment_total numeric not null,
  resume_token text not null unique,
  status text not null default 'in_progress'
    check (status in ('not_started','in_progress','complete')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_checkout_sessions_token on public.financing_checkout_sessions (resume_token);
create index if not exists idx_checkout_sessions_lead on public.financing_checkout_sessions (lead_id);

create table if not exists public.financing_checkout_subapps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  session_id uuid not null references public.financing_checkout_sessions(id) on delete cascade,
  lender_slug text not null,
  lender_name text not null,
  requested_amount numeric not null,
  term jsonb not null,                           -- LenderTermOption
  status text not null default 'selected'
    check (status in ('selected','link_sent','started','approved','funded','declined','expired')),
  funded_amount numeric not null default 0,
  confirmed_by text check (confirmed_by in ('staff','patient','webhook')),
  application_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_checkout_subapps_session on public.financing_checkout_subapps (session_id);

alter table public.financing_checkout_sessions enable row level security;
alter table public.financing_checkout_subapps enable row level security;

drop policy if exists checkout_sessions_org_isolation on public.financing_checkout_sessions;
create policy checkout_sessions_org_isolation on public.financing_checkout_sessions
  for all
  using (organization_id = public.get_user_org_id())
  with check (organization_id = public.get_user_org_id());

drop policy if exists checkout_subapps_org_isolation on public.financing_checkout_subapps;
create policy checkout_subapps_org_isolation on public.financing_checkout_subapps
  for all
  using (organization_id = public.get_user_org_id())
  with check (organization_id = public.get_user_org_id());

comment on table public.financing_checkout_sessions is 'A stacked financing plan the patient proceeds with. resume_token is durable/reusable for the multi-visit "pick back up" flow. Public GET is by token (service client), not RLS.';
comment on table public.financing_checkout_subapps is 'Per-lender sub-application within a checkout session; small state machine reconciled by staff one-tap / patient self-report / webhook.';
