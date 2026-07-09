-- Dion Desk outbox
-- ================
-- When an inbound call matches an existing CareStack patient, the front-desk
-- workflow is owned by Dion Desk (ecosystem matrix), not the LI sales funnel.
-- LI parks the record off-funnel AND hands it to Desk. Desk is not yet
-- provisioned to receive (demo-only, no SF tenant), so this is a DURABLE outbox:
-- ingestion enqueues here; a forwarder cron drains it to Desk's bus receiver once
-- DION_DESK_URL is configured. Until then rows sit 'pending' — nothing is lost.
--
-- Bus rule: rows carry IDs / references / codes ONLY — never PHI content.

create table if not exists public.dion_desk_outbox (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  lead_id          uuid references public.leads(id) on delete cascade,
  patient_id       uuid,
  event_type       text not null,
  payload          jsonb not null default '{}'::jsonb,
  status           text not null default 'pending' check (status in ('pending','sent','failed')),
  attempts         integer not null default 0,
  last_error       text,
  idempotency_key  text not null unique,
  created_at       timestamptz not null default now(),
  sent_at          timestamptz
);

-- Drain index: the forwarder scans not-yet-sent rows oldest-first.
create index if not exists idx_dion_desk_outbox_pending
  on public.dion_desk_outbox (created_at)
  where status <> 'sent';

-- Service-role-only table (the bridge writes/reads it with the service key, which
-- bypasses RLS). RLS enabled with NO policies => no authenticated/anon access.
alter table public.dion_desk_outbox enable row level security;

comment on table public.dion_desk_outbox is
  'Durable outbox: existing-patient inbound contacts handed from Lead Intelligence to Dion Desk. Buffers until Desk is provisioned + DION_DESK_URL set. IDs/codes only, no PHI.';
