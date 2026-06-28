-- ============================================================================
-- Growth Studio writeback robustness
-- ============================================================================
-- Fixes three gaps in 20260603_growth_studio_lead_event_writeback.sql:
--   1. Correlation relied on regexing "dgs_lead_id: <uuid>" out of leads.notes —
--      but nothing in LI reliably writes that, so every writeback could no-op.
--      Add an explicit leads.external_ref column (populated by the v1 bridge),
--      preferred over the notes regex.
--   2. value_cents only read treatment_value; won/accepted revenue often lives in
--      actual_revenue → conversions sent to Meta CAPI with no value. Coalesce.
--   3. pg_net is fire-and-forget with no retry/DLQ → a single DGS outage silently
--      drops the conversion forever. Record every event in a durable outbox so a
--      cron worker can retry undelivered ones.
-- ============================================================================

alter table public.leads
  add column if not exists external_ref text;
create index if not exists idx_leads_external_ref
  on public.leads(external_ref) where external_ref is not null;

-- Durable outbox: every emitted lifecycle event is recorded here, then a worker
-- (re)delivers undelivered rows. Service-role only.
create table if not exists public.growth_studio_event_outbox (
  id uuid primary key default gen_random_uuid(),
  event_id text not null unique,           -- stable idempotency key: li_lead_id:stage
  li_lead_id uuid not null,
  organization_id uuid not null,
  dgs_lead_id text not null,
  stage text not null,
  value_cents bigint,
  payload jsonb not null,
  delivered boolean not null default false,
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);
create index if not exists idx_gs_outbox_undelivered
  on public.growth_studio_event_outbox(created_at) where delivered = false;
alter table public.growth_studio_event_outbox enable row level security;
-- No policies → only the service role / definer functions can read it.

create or replace function public.notify_growth_studio_lead_event()
returns trigger
language plpgsql
security definer
set search_path = public, net
as $$
declare
  cfg        record;
  canonical  text;
  dgs_id     text;
  val_cents  bigint;
  evt_id     text;
  body       jsonb;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  canonical := case new.status
    when 'contacted'               then 'contacted'
    when 'qualified'               then 'qualified'
    when 'consultation_scheduled'  then 'consult_booked'
    when 'consultation_completed'  then 'showed'
    when 'treatment_presented'     then 'showed'
    when 'contract_signed'         then 'treatment_accepted'
    when 'in_treatment'            then 'won'
    when 'completed'               then 'won'
    when 'lost'                    then 'lost'
    when 'disqualified'            then 'lost'
    else null
  end;
  if canonical is null then
    return new;
  end if;

  -- Prefer the explicit external_ref; fall back to the legacy notes regex.
  dgs_id := coalesce(
    new.external_ref,
    substring(new.notes from 'dgs_lead_id:\s*([0-9a-fA-F-]{36})')
  );
  if dgs_id is null then
    return new;  -- not a Growth Studio lead.
  end if;

  -- Revenue can live in actual_revenue (won) or treatment_value (accepted).
  val_cents := case
    when canonical in ('treatment_accepted', 'won')
    then round(coalesce(new.actual_revenue, new.treatment_value, 0) * 100)::bigint
    else null
  end;

  -- Stable idempotency key so DGS (and the outbox) dedupe re-fires.
  evt_id := new.id::text || ':' || canonical;

  body := jsonb_build_object(
    'event_id',    evt_id,
    'customer_id', new.organization_id,
    'stage',       canonical,
    'lead_id',     dgs_id,
    'value_cents', val_cents,
    'li_lead_id',  new.id,
    'occurred_at', now()
  );

  -- Durable record first (idempotent on event_id) so nothing is lost even if the
  -- HTTP post below fails or the config isn't armed yet.
  insert into public.growth_studio_event_outbox
    (event_id, li_lead_id, organization_id, dgs_lead_id, stage, value_cents, payload)
  values
    (evt_id, new.id, new.organization_id, dgs_id, canonical, val_cents, body)
  on conflict (event_id) do nothing;

  -- Best-effort low-latency delivery. Marked delivered by the worker on success.
  select * into cfg from public.growth_studio_webhook_config where id = true and enabled;
  if found then
    perform net.http_post(
      url     := cfg.url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.bearer),
      body    := body
    );
  end if;

  return new;
end;
$$;
