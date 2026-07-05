-- Live usage rollup for the cost panels.
--
-- The cost_events ledger is only sparsely populated (SMS/voice capture lags), so the Spend &
-- Margin panel and the per-account Usage page compute cost/billable *live* from the source
-- tables — messages (SMS + email), voice_calls (phone), ai_usage (AI). This function is the one
-- aggregation point: it returns raw quantities per org over a window; the app layer applies the
-- rate card (src/lib/billing/pricing.ts) and re-bill markup (markup.ts) so pricing stays single-
-- source in TypeScript.
--
-- SECURITY DEFINER + explicit in-function authorization: p_org = NULL returns every practice and
-- requires agency-admin; p_org set returns that one practice and requires agency-admin OR that the
-- caller belongs to it. This lets the agency super-admin panel see all practices while the account
-- page a practice user opens is scoped to their own org, without widening base-table RLS.

create or replace function public.usage_rollup(p_since timestamptz, p_org uuid default null)
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
      and (p_org is null or a.organization_id = p_org)
    group by a.organization_id
  ),
  ids as (
    select oid from msg
    union
    select oid from vc
    union
    select oid from ai
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

grant execute on function public.usage_rollup(timestamptz, uuid) to authenticated;

comment on function public.usage_rollup(timestamptz, uuid) is
  'Per-org usage quantities (SMS/email/voice/AI) over a window for the live cost panels. '
  'SECURITY DEFINER with in-function authz: NULL org => all practices (agency admin only); '
  'set org => that practice (agency admin or member).';
