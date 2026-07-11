-- Allow the service role (server crons) to call usage_rollup.
--
-- The daily usage→Stripe meter cron (api/cron/report-usage) runs with the service-role client,
-- which has no JWT — so is_agency_admin()/get_user_org_id() are both null and the existing guard
-- raises 42501. The service role already bypasses RLS and can read every source table directly, so
-- letting it call the rollup grants no new access; it just reuses the same pricing-consistent
-- aggregation the panels and monthly invoices use, instead of duplicating it in TypeScript.
--
-- Body is byte-for-byte the current definition (20260711234500) except the authorization block,
-- which now also admits `session_user = 'service_role'`. All aggregation/joins are unchanged.

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
  -- service_role (server crons) is always allowed — it already bypasses RLS. Otherwise:
  -- cross-practice rollups (all practices, or a whole enterprise) require agency admin;
  -- a single-org rollup is allowed for that org's own members too.
  if session_user <> 'service_role' then
    if p_org is not null then
      if not (public.is_agency_admin() or p_org = public.get_user_org_id()) then
        raise exception 'not authorized for organization %', p_org using errcode = '42501';
      end if;
    elsif not public.is_agency_admin() then
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
  join public.organizations o on o.id = i.oid
  where i.oid is not null
    and (p_enterprise is null or o.enterprise_account_id = p_enterprise);
end;
$$;
