-- Supersedes the writeback wiring in 20260603_growth_studio_lead_event_writeback.sql.
--
-- Three changes, all additive / idempotent:
--   1. leads.external_ref — first-class, indexed correlation id (the DGS
--      inbound_leads.id). DGS now sends it as a top-level body field on
--      POST /api/v1/leads; the API stores it here. We still read the legacy
--      `dgs_lead_id: <uuid>` embedded in notes as a fallback for older rows.
--   2. growth_studio_outbox — durable record of every writeback attempt,
--      capturing the pg_net request id so a (future) reconcile sweep can tell
--      delivered from failed instead of the signal vanishing fire-and-forget.
--   3. notify_growth_studio_lead_event() reworked to:
--        - resolve the id via coalesce(external_ref, notes-regex)
--        - complete the status→canonical CASE map
--        - RAISE LOG on any unmapped status (so gaps are visible)
--        - INSERT an outbox row holding the net.http_post request id
--
-- The original 20260603 file is left in place (do not delete); this migration
-- ALTERs the table and CREATE OR REPLACEs the function to take over.

-- 1. Correlation column ---------------------------------------------------------
alter table public.leads add column if not exists external_ref text;
create index if not exists idx_leads_external_ref on public.leads (external_ref);

-- 2. Delivery / audit outbox ----------------------------------------------------
create table if not exists public.growth_studio_outbox (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid,
  external_ref text,
  stage        text,
  value_cents  bigint,
  request_id   bigint,
  status       text default 'pending',
  attempts     int default 0,
  last_error   text,
  created_at   timestamptz default now(),
  delivered_at timestamptz
);
alter table public.growth_studio_outbox enable row level security;
-- No policies → service role / definer functions only (same posture as the config table).
create index if not exists idx_gs_outbox_status on public.growth_studio_outbox (status);
create index if not exists idx_gs_outbox_request_id on public.growth_studio_outbox (request_id);

-- 3. Reworked trigger function --------------------------------------------------
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
  body       jsonb;
  req_id     bigint;
  val_cents  bigint;
begin
  -- Only react to an actual status change.
  if new.status is not distinct from old.status then
    return new;
  end if;

  -- Map the LI lead status onto a DGS canonical lifecycle stage. The DGS side
  -- is monotonic, so emitting an intermediate/earlier stage is a safe no-op.
  canonical := case new.status
    when 'contacted'               then 'contacted'
    when 'qualified'               then 'qualified'
    when 'consultation_scheduled'  then 'consult_booked'
    when 'scheduled'               then 'consult_booked'
    when 'consultation_completed'  then 'showed'
    when 'treatment_presented'     then 'showed'
    when 'financing'               then 'showed'
    when 'contract_sent'           then 'treatment_accepted'
    when 'contract_signed'         then 'treatment_accepted'
    when 'in_treatment'            then 'won'
    when 'completed'               then 'won'
    when 'lost'                    then 'lost'
    when 'disqualified'            then 'lost'
    -- no_show / unresponsive are intentionally NOT propagated.
    when 'no_show'                 then null
    when 'unresponsive'            then null
    else null
  end;

  if canonical is null then
    -- Surface any status we don't yet map (excluding the intentional no-ops) so
    -- future status additions don't silently drop conversions.
    if new.status not in ('no_show', 'unresponsive', 'new') then
      raise log 'notify_growth_studio_lead_event: unmapped lead status %, lead %', new.status, new.id;
    end if;
    return new;  -- nothing to propagate.
  end if;

  -- Correlation id: prefer the first-class column, fall back to the legacy
  -- notes-embedded value for rows created before external_ref existed.
  dgs_id := coalesce(
    new.external_ref,
    substring(new.notes from 'dgs_lead_id:\s*([0-9a-fA-F-]{36})')
  );
  if dgs_id is null then
    return new;  -- lead didn't originate from Growth Studio — nothing to sync.
  end if;

  select * into cfg from public.growth_studio_webhook_config where id = true and enabled;
  if not found then
    return new;  -- not armed yet.
  end if;

  val_cents := case
                 when canonical in ('treatment_accepted', 'won') and new.treatment_value is not null
                 then round(new.treatment_value * 100)::bigint
                 else null
               end;

  body := jsonb_build_object(
    'customer_id', new.organization_id,
    'stage',       canonical,
    'lead_id',     dgs_id,
    'value_cents', val_cents,
    'li_lead_id',  new.id,
    'occurred_at', now()
  );

  -- Async HTTP via pg_net. Capture the returned request id instead of discarding
  -- it, and record the attempt in the outbox so delivery is auditable/retryable.
  req_id := net.http_post(
    url     := cfg.url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.bearer),
    body    := body
  );

  insert into public.growth_studio_outbox
    (lead_id, external_ref, stage, value_cents, request_id, status, attempts)
  values
    (new.id, dgs_id, canonical, val_cents, req_id, 'pending', 1);

  return new;
end;
$$;

-- Trigger definition is unchanged from 20260603; re-assert it so this migration
-- is self-contained if applied against a DB that never ran the prior one.
drop trigger if exists trg_notify_growth_studio on public.leads;
create trigger trg_notify_growth_studio
  after update of status on public.leads
  for each row
  execute function public.notify_growth_studio_lead_event();
