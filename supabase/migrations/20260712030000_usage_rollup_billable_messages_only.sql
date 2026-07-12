-- usage_rollup: count only messages Lead Intelligence actually transmitted.
--
-- Bug: the SMS/email counts summed EVERY messages row in the window, but `messages` is also
-- the conversation timeline — the GHL history sync (webhook + backfill, lib/ghl/ingest-message.ts)
-- mirrors messages that GHL/LeadConnector sent and billed on its own account. For SF Dentistry's
-- last 30 days that was 16,339 of 16,353 "sent" SMS (and all of the emails): the Usage page showed
-- $1,148.53 of SMS when LI's own Twilio traffic was 14 outbound messages — about a dollar. The
-- same rollup feeds monthly invoicing and the Stripe usage-meter cron, so this was a live
-- overbilling bug, not just a display one.
--
-- Fixes, all in the msg CTE (voice/ai CTEs unchanged):
--   1. Provenance filter, deny-by-default: only rows with NO import marker are billable.
--      Convention: importers must set metadata.source (GHL sets 'ghl' and external_id
--      'ghl_msg:…'); LI's own senders never set metadata.source. Any future import source is
--      therefore excluded automatically instead of billed by default.
--   2. Outbound with status 'failed' (never handed to the carrier, Twilio doesn't bill it)
--      no longer counts. 'undelivered'/'bounced' still count — providers bill the attempt.
--   3. Segment estimate is now encoding-aware: GSM-7 packs 160 chars in a single segment /
--      153 per concatenated part; messages with non-ASCII chars fall back to UCS-2 (70 / 67).
--      Still an estimate — Twilio's authoritative num_segments lands in cost_events via the
--      reconcile-costs cron; this keeps the live panel close to it.
--
-- Authorization block is byte-for-byte the current definition (20260712000100).

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
      count(*) filter (where m.channel = 'sms' and m.direction = 'outbound'
                         and m.status is distinct from 'failed') as sms_out_count,
      coalesce(sum(
        case
          when coalesce(m.body, '') = '' then 1
          when m.body ~ '[^[:ascii:]]' then -- UCS-2: 70 chars single, 67 per concatenated part
            case when char_length(m.body) <= 70 then 1
                 else ceil(char_length(m.body) / 67.0) end
          else                              -- GSM-7: 160 chars single, 153 per concatenated part
            case when char_length(m.body) <= 160 then 1
                 else ceil(char_length(m.body) / 153.0) end
        end
      ) filter (where m.channel = 'sms' and m.direction = 'outbound'
                  and m.status is distinct from 'failed'), 0) as sms_out_segments,
      count(*) filter (where m.channel = 'sms' and m.direction = 'inbound') as sms_in_count,
      count(*) filter (where m.channel = 'email' and m.direction = 'outbound'
                         and m.status is distinct from 'failed') as email_out_count
    from public.messages m
    where m.created_at >= p_since
      and (p_until is null or m.created_at < p_until)
      and (p_org is null or m.organization_id = p_org)
      -- Billable = transmitted by LI. Imported mirrors carry a provenance marker
      -- (metadata.source, e.g. 'ghl'); anything marked is excluded, deny-by-default.
      and m.metadata->>'source' is null
      and (m.external_id is null or m.external_id not like 'ghl_msg:%')
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
