-- LI → Dion Growth Studio conversion writeback.
--
-- When a lead that originated from Growth Studio advances through the funnel,
-- emit a normalized lifecycle event to the DGS lead-event-webhook so DGS can
-- update its inbound_lead and fire Meta CAPI (BookedConsult / TreatmentAccepted).
-- This is what lets GHL be switched off without losing the conversion signal.
--
-- Design notes:
--   * Single AFTER UPDATE OF status trigger → covers every code path that moves
--     a lead, with no application changes.
--   * PII-safe: phone/email are encrypted at rest, so we DON'T use them. The DGS
--     shadow push embeds "dgs_lead_id: <uuid>" in notes; we regex it out and send
--     it as the match key. Leads with no dgs_lead_id (i.e. not from DGS) are
--     skipped — nothing to write back.
--   * DORMANT until armed: the trigger no-ops unless a row exists in
--     growth_studio_webhook_config. Deploy is therefore safe; arming is a
--     deliberate, separate step (insert the config row) once the DGS edge
--     function is deployed and the shared key is confirmed.

create extension if not exists pg_net;

-- One-row config holding the DGS webhook URL + bearer. Service-role only.
create table if not exists public.growth_studio_webhook_config (
  id boolean primary key default true check (id),
  url text not null,
  bearer text not null,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.growth_studio_webhook_config enable row level security;
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
  body       jsonb;
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
    return new;  -- status we don't propagate (no_show, dormant, financing, etc.)
  end if;

  -- The DGS correlation id, embedded in notes by the shadow push. UUID v4 shape.
  dgs_id := substring(new.notes from 'dgs_lead_id:\s*([0-9a-fA-F-]{36})');
  if dgs_id is null then
    return new;  -- lead didn't originate from Growth Studio — nothing to sync.
  end if;

  select * into cfg from public.growth_studio_webhook_config where id = true and enabled;
  if not found then
    return new;  -- not armed yet.
  end if;

  body := jsonb_build_object(
    'customer_id', new.organization_id,
    'stage',       canonical,
    'lead_id',     dgs_id,
    'value_cents', case
                     when canonical in ('treatment_accepted', 'won') and new.treatment_value is not null
                     then round(new.treatment_value * 100)::bigint
                     else null
                   end,
    'li_lead_id',  new.id,
    'occurred_at', now()
  );

  -- Fire-and-forget async HTTP (pg_net). Failures are queued/logged by pg_net
  -- and never block the lead update.
  perform net.http_post(
    url     := cfg.url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.bearer),
    body    := body
  );

  return new;
end;
$$;

drop trigger if exists trg_notify_growth_studio on public.leads;
create trigger trg_notify_growth_studio
  after update of status on public.leads
  for each row
  execute function public.notify_growth_studio_lead_event();

-- ── Arming (run manually, post-deploy, once the DGS edge fn is live) ──────────
-- insert into public.growth_studio_webhook_config (url, bearer)
-- values (
--   'https://jqdtnztfadfhycrdwobz.functions.supabase.co/lead-event-webhook',
--   '<the shared GROWTH_STUDIO service key>'
-- )
-- on conflict (id) do update
--   set url = excluded.url, bearer = excluded.bearer, enabled = true, updated_at = now();
