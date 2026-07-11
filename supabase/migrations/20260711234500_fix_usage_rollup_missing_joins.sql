-- Fix: usage_rollup lost its data joins in the enterprise migration.
--
-- 20260711220100_usage_rollup_enterprise.sql rewrote the final SELECT to add the
-- `join organizations o` needed for p_enterprise filtering, but dropped the three
-- `left join msg / vc / ai` that actually pull the per-service counts into each
-- output row. The SELECT list still references msg./vc./ai. columns, so every call
-- raised `42P01: missing FROM-clause entry for table "msg"`. loadLiveSpend() swallows
-- the RPC error into an empty shape, so the Usage & Costs page and the agency Spend
-- panel silently showed "No usage" / $0.00 even though messages/voice_calls/ai_usage
-- were being written normally.
--
-- This restores the LEFT JOINs while keeping the organizations join + enterprise
-- filter. Signature is unchanged (4-arg), so no overload/ambiguity concerns.

create or replace function public.usage_rollup(
  p_since timestamptz,
  p_org uuid default null,
  p_until timestamptz default null,
  p_enterprise uuid default null
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
  -- ── Authorization ────────────────────────────────────────────
  -- Cross-practice rollups (all practices, or a whole enterprise) require agency
  -- admin. A single-org rollup is allowed for that org's own members too.
  if p_org is not null then
    if not (public.is_agency_admin() or p_org = public.get_user_org_id()) then
      raise exception 'not authorized for organization %', p_org using errcode = '42501';
    end if;
  elsif not public.is_agency_admin() then
    raise exception 'agency admin required for cross-practice rollup' using errcode = '42501';
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
  -- Data joins (restored): pull per-service counts into each org's row.
  left join msg on msg.oid = i.oid
  left join vc on vc.oid = i.oid
  left join ai on ai.oid = i.oid
  -- Enterprise scope: join organizations only to filter output rows to the
  -- requested enterprise. NULL p_enterprise => no filter (unchanged behavior).
  join public.organizations o on o.id = i.oid
  where i.oid is not null
    and (p_enterprise is null or o.enterprise_account_id = p_enterprise);
end;
$$;

grant execute on function public.usage_rollup(timestamptz, uuid, timestamptz, uuid) to authenticated;

comment on function public.usage_rollup(timestamptz, uuid, timestamptz, uuid) is
  'Per-org usage quantities (SMS/email/voice/AI) over a window for the live cost panels. '
  'SECURITY DEFINER with in-function authz: NULL org => all practices (agency admin only); '
  'set org => that practice (agency admin or member). Optional p_enterprise filters output '
  'rows to one enterprise (DSO) for rolled-up reporting; grouping stays per-org.';
