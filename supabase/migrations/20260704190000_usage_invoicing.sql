-- Usage invoicing for Lead Intelligence practices.
--
-- The existing `invoices` table is a read-only CareStack EHR mirror (patient payments for Meta
-- CAPI) — the wrong home for LI usage billing. This adds a dedicated `usage_invoices` ledger and
-- extends the usage_rollup RPC with an upper time bound so a *bounded* month can be priced (the
-- panels use a trailing window; an invoice needs a closed [start, end) period).

-- ── 1. usage_rollup gains an optional upper bound (p_until) ──────────────────
-- Drop the 2-arg version and recreate with p_until so there's exactly one overload (no ambiguity).
drop function if exists public.usage_rollup(timestamptz, uuid);

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
  if p_org is not null then
    if not (public.is_agency_admin() or p_org = public.get_user_org_id()) then
      raise exception 'not authorized for organization %', p_org using errcode = '42501';
    end if;
  else
    if not public.is_agency_admin() then
      raise exception 'agency admin required for cross-practice rollup' using errcode = '42501';
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

grant execute on function public.usage_rollup(timestamptz, uuid, timestamptz) to authenticated;

-- ── 2. usage_invoices ledger ────────────────────────────────────────────────
create table if not exists public.usage_invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  usage_cost_cents numeric not null default 0,       -- what we paid providers
  usage_billable_cents numeric not null default 0,   -- usage re-billed (cost × markup)
  platform_fee_cents numeric not null default 0,     -- flat monthly fee for the period
  total_cents numeric not null default 0,            -- usage_billable + platform_fee
  line_items jsonb not null default '[]'::jsonb,      -- per-service {service, qty, cost, billable, markupPct}
  status text not null default 'draft',              -- draft | issued | void
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, period_start, period_end)
);

create index if not exists usage_invoices_org_period_idx
  on public.usage_invoices (organization_id, period_start desc);

alter table public.usage_invoices enable row level security;

-- Agency admins manage every practice's invoices.
drop policy if exists "Agency admins manage usage_invoices" on public.usage_invoices;
create policy "Agency admins manage usage_invoices"
  on public.usage_invoices for all
  using (public.is_agency_admin())
  with check (public.is_agency_admin());

-- A practice can read its own issued invoices (not drafts).
drop policy if exists "Practices read own issued usage_invoices" on public.usage_invoices;
create policy "Practices read own issued usage_invoices"
  on public.usage_invoices for select
  using (organization_id = public.get_user_org_id() and status = 'issued');

comment on table public.usage_invoices is
  'Lead Intelligence usage billing per practice per period (usage re-bill + platform fee). '
  'Separate from the EHR-mirror `invoices` table. Composed from usage_rollup.';
