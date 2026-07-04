-- Prepaid usage balance + auto-reload (the "credits wallet" billing model).
--
-- In `prepaid` mode a practice's usage (AI/SMS/voice, at markup) draws down a prepaid balance; when
-- the balance falls to the low-balance threshold (default 10% of the reload amount) the saved card
-- is charged for the reload amount and the balance is topped back up. Alternative to the postpaid
-- monthly usage invoice — `billing_mode` selects which. Ships dormant: mode defaults 'invoice'.

alter table public.billing_settings
  add column if not exists billing_mode text not null default 'invoice',
  add column if not exists auto_reload boolean not null default false,
  add column if not exists reload_amount_cents integer,           -- top-up amount per reload
  add column if not exists low_balance_pct integer not null default 10, -- reload when balance <= this % of reload amount
  add column if not exists balance_cents numeric(14, 4) not null default 0,
  add column if not exists balance_settled_through timestamptz;    -- usage debited up to this instant

alter table public.billing_settings
  drop constraint if exists billing_settings_billing_mode_chk;
alter table public.billing_settings
  add constraint billing_settings_billing_mode_chk check (billing_mode in ('invoice', 'prepaid'));

-- Wallet ledger: every credit (reload) and debit (usage / monthly fee) with the running balance.
create table if not exists public.balance_transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null check (kind in ('credit', 'debit')),
  amount_cents numeric(14, 4) not null,
  reason text not null,                 -- 'usage' | 'reload' | 'platform_fee' | 'manual' | ...
  balance_after numeric(14, 4) not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists balance_transactions_org_idx
  on public.balance_transactions (organization_id, created_at desc);

alter table public.balance_transactions enable row level security;

drop policy if exists "Agency admins manage balance_transactions" on public.balance_transactions;
create policy "Agency admins manage balance_transactions"
  on public.balance_transactions for all
  using (public.is_agency_admin())
  with check (public.is_agency_admin());

drop policy if exists "Practices read own balance_transactions" on public.balance_transactions;
create policy "Practices read own balance_transactions"
  on public.balance_transactions for select
  using (organization_id = public.get_user_org_id());

comment on table public.balance_transactions is
  'Prepaid usage-wallet ledger: reloads (credit) and usage/fee draw-downs (debit) with running balance.';

-- Let trusted server-role crons (auth.uid() is null) call usage_rollup so the balance cron can
-- compute each practice's usage draw-down. Human callers are still scoped as before.
create or replace function public.usage_rollup(
  p_since timestamptz,
  p_org uuid default null,
  p_until timestamptz default null
)
returns table (
  organization_id uuid,
  sms_out_count bigint,
  sms_out_segments numeric,
  sms_in_count bigint,
  email_out_count bigint,
  voice_seconds bigint,
  voice_calls bigint,
  ai_cost_cents numeric,
  ai_calls bigint,
  ai_tokens_in bigint,
  ai_tokens_out bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- Trusted server role (null auth.uid) — e.g. the balance/invoice crons — is allowed through.
  if auth.uid() is not null then
    if p_org is not null then
      if not (public.is_agency_admin() or p_org = public.get_user_org_id()) then
        raise exception 'not authorized for organization %', p_org using errcode = '42501';
      end if;
    else
      if not public.is_agency_admin() then
        raise exception 'agency admin required for cross-practice rollup' using errcode = '42501';
      end if;
    end if;
  end if;

  return query
  with msg as (
    select
      m.organization_id as oid,
      count(*) filter (where m.channel = 'sms' and m.direction = 'outbound') as sms_out_count,
      coalesce(sum(ceil(greatest(length(coalesce(m.body, '')), 1) / 160.0))
               filter (where m.channel = 'sms' and m.direction = 'outbound'), 0) as sms_out_segments,
      count(*) filter (where m.channel = 'sms' and m.direction = 'inbound') as sms_in_count,
      count(*) filter (where m.channel = 'email' and m.direction = 'outbound') as email_out_count
    from public.messages m
    where m.created_at >= p_since
      and (p_until is null or m.created_at < p_until)
      and (p_org is null or m.organization_id = p_org)
    group by m.organization_id
  ),
  vc as (
    select
      v.organization_id as oid,
      coalesce(sum(v.duration_seconds), 0) as voice_seconds,
      count(*) as voice_calls
    from public.voice_calls v
    where v.created_at >= p_since
      and (p_until is null or v.created_at < p_until)
      and (p_org is null or v.organization_id = p_org)
    group by v.organization_id
  ),
  ai as (
    select
      a.organization_id as oid,
      coalesce(sum(a.cost_cents), 0) as ai_cost_cents,
      count(*) as ai_calls,
      coalesce(sum(a.tokens_in), 0) as ai_tokens_in,
      coalesce(sum(a.tokens_out), 0) as ai_tokens_out
    from public.ai_usage a
    where a.occurred_at >= p_since
      and (p_until is null or a.occurred_at < p_until)
      and (p_org is null or a.organization_id = p_org)
    group by a.organization_id
  ),
  ids as (
    select oid from msg union select oid from vc union select oid from ai
  )
  select
    i.oid as organization_id,
    coalesce(msg.sms_out_count, 0)::bigint,
    coalesce(msg.sms_out_segments, 0)::numeric,
    coalesce(msg.sms_in_count, 0)::bigint,
    coalesce(msg.email_out_count, 0)::bigint,
    coalesce(vc.voice_seconds, 0)::bigint,
    coalesce(vc.voice_calls, 0)::bigint,
    coalesce(ai.ai_cost_cents, 0)::numeric,
    coalesce(ai.ai_calls, 0)::bigint,
    coalesce(ai.ai_tokens_in, 0)::bigint,
    coalesce(ai.ai_tokens_out, 0)::bigint
  from ids i
  left join msg on msg.oid = i.oid
  left join vc on vc.oid = i.oid
  left join ai on ai.oid = i.oid
  where i.oid is not null;
end;
$$;
