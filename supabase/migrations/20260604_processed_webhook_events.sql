-- ============================================================================
-- Webhook replay protection
-- ============================================================================
-- Inbound provider webhooks (CareStack first) were verified by HMAC but had no
-- record of which events were already processed. A passively-captured signed
-- webhook could be replayed verbatim forever — each replay re-creates a lead /
-- re-emits a conversion (Meta CAPI inflation, fake revenue).
--
-- This table is the dedupe ledger: the handler INSERTs (org, source, event_hash)
-- before processing; the unique PK makes a replay's insert conflict, so the
-- event is processed exactly once. event_hash = sha256(accountId + ':' + rawBody).
-- ============================================================================

create table if not exists public.processed_webhook_events (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source text not null,
  event_hash text not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, source, event_hash)
);

-- For periodic cleanup of old rows (the table only needs a sliding window).
create index if not exists idx_processed_webhook_events_created
  on public.processed_webhook_events(created_at);

alter table public.processed_webhook_events enable row level security;
-- No policies → only the service role / definer functions can read or write it.
create policy "processed_webhook_events_service" on public.processed_webhook_events
  for all to service_role using (true) with check (true);
