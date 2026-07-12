-- AI-vs-Human scoreboard RPCs (Automation Command Center)
-- ========================================================
-- Two org-guarded, security-definer reads powering /dashboard/automation:
--
--   automation_scoreboard(org, from, to)
--     One row per lane ('ai' | 'human'):
--       * first-response metrics from message_response_slas (median + p90
--         response seconds by responder_type, sla_met rate, AI-takeover count)
--       * volume + engagement from messages (outbound count by sender_type,
--         reply rate = share of outbound followed by an inbound on the same
--         conversation within 24h)
--       * human-task throughput (completed / total, avg claim latency) — human
--         lane only; escalation count — AI lane only.
--
--   automation_outcomes(org, from, to)
--     One row per lead lane ('ai' | 'human' | 'mixed'): a lead-period is
--     classified by WHICH sender types messaged it inside the window;
--     conversions = converted_at inside the window; revenue = actual_revenue
--     summed over those conversions. TOUCH-BASED ATTRIBUTION, NOT CAUSAL LIFT —
--     the UI labels it as such.
--
-- Bounded: every scan is anchored on an indexed (organization_id, created_at /
-- inbound_at) predicate; the reply-rate probe is an EXISTS against
-- idx_messages_conversation (conversation_id, created_at). Callers pass
-- windows of 7/30/90 days; a hard 400-day cap guards against runaway ranges.

create or replace function public.automation_scoreboard(
  p_org_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns table (
  lane text,
  median_response_seconds numeric,
  p90_response_seconds numeric,
  responses bigint,
  sla_met_rate numeric,
  takeover_count bigint,
  outbound_messages bigint,
  replied_messages bigint,
  reply_rate numeric,
  tasks_completed bigint,
  tasks_total bigint,
  avg_claim_seconds numeric,
  escalation_count bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  -- SECURITY DEFINER bypasses RLS, so guard the org boundary explicitly:
  -- service-role (crons) may query any org; users only their own.
  if auth.role() is distinct from 'service_role'
     and p_org_id is distinct from get_user_org_id() then
    raise exception 'automation_scoreboard: organization mismatch';
  end if;

  if p_to <= p_from or p_to - p_from > interval '400 days' then
    raise exception 'automation_scoreboard: invalid window';
  end if;

  return query
  with resp as (
    -- First-response latency + SLA hit rate, split by who actually responded.
    select
      s.responder_type as r_lane,
      percentile_cont(0.5) within group (
        order by extract(epoch from s.first_response_at - s.inbound_at)
      ) as med_s,
      percentile_cont(0.9) within group (
        order by extract(epoch from s.first_response_at - s.inbound_at)
      ) as p90_s,
      count(*)::bigint as n_responses,
      avg(case when s.sla_met then 1.0 else 0.0 end) as met_rate
    from message_response_slas s
    where s.organization_id = p_org_id
      and s.inbound_at >= p_from and s.inbound_at < p_to
      and s.first_response_at is not null
      and s.responder_type in ('human', 'ai')
    group by s.responder_type
  ),
  takeovers as (
    -- The human window expired and the AI covered the lead.
    select count(*)::bigint as n
    from message_response_slas s
    where s.organization_id = p_org_id
      and s.inbound_at >= p_from and s.inbound_at < p_to
      and s.status = 'ai_takeover'
  ),
  outb as (
    -- Outbound volume + 24h reply rate by sender lane. sender_type 'user' =
    -- staff; 'ai' = autopilot. 'system' messages belong to neither lane.
    select
      case when m.sender_type = 'ai' then 'ai' else 'human' end as o_lane,
      count(*)::bigint as n_outbound,
      count(*) filter (where exists (
        select 1 from messages r
        where r.conversation_id = m.conversation_id
          and r.direction = 'inbound'
          and r.created_at > m.created_at
          and r.created_at <= m.created_at + interval '24 hours'
      ))::bigint as n_replied
    from messages m
    where m.organization_id = p_org_id
      and m.created_at >= p_from and m.created_at < p_to
      and m.direction = 'outbound'
      and m.sender_type in ('ai', 'user')
    group by 1
  ),
  tasks as (
    select
      count(*) filter (where t.status = 'done')::bigint as n_completed,
      count(*)::bigint as n_total,
      avg(extract(epoch from t.claimed_at - t.created_at))
        filter (where t.claimed_at is not null) as claim_s
    from human_tasks t
    where t.organization_id = p_org_id
      and t.created_at >= p_from and t.created_at < p_to
  ),
  esc as (
    select count(*)::bigint as n
    from escalations e
    where e.organization_id = p_org_id
      and e.created_at >= p_from and e.created_at < p_to
  )
  select
    l.l_lane,
    round(resp.med_s::numeric, 1),
    round(resp.p90_s::numeric, 1),
    coalesce(resp.n_responses, 0),
    round(resp.met_rate::numeric, 4),
    case when l.l_lane = 'ai' then takeovers.n else 0 end,
    coalesce(outb.n_outbound, 0),
    coalesce(outb.n_replied, 0),
    case when coalesce(outb.n_outbound, 0) > 0
      then round(outb.n_replied::numeric / outb.n_outbound, 4) end,
    case when l.l_lane = 'human' then tasks.n_completed else 0 end,
    case when l.l_lane = 'human' then tasks.n_total else 0 end,
    case when l.l_lane = 'human' then round(tasks.claim_s::numeric, 1) end,
    case when l.l_lane = 'ai' then esc.n else 0 end
  from (values ('ai'), ('human')) as l(l_lane)
  left join resp on resp.r_lane = l.l_lane
  left join outb on outb.o_lane = l.l_lane
  cross join takeovers
  cross join tasks
  cross join esc;
end;
$$;

comment on function public.automation_scoreboard(uuid, timestamptz, timestamptz) is
  'AI-vs-Human lane metrics for one org + window: first-response median/p90 + SLA-met rate (message_response_slas by responder_type), outbound volume + 24h reply rate (messages by sender_type ai vs user), human-task throughput, AI takeovers + escalations. Org-guarded security definer.';

grant execute on function public.automation_scoreboard(uuid, timestamptz, timestamptz)
  to authenticated, service_role;

create or replace function public.automation_outcomes(
  p_org_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns table (
  lane text,
  leads_touched bigint,
  conversions bigint,
  conversion_rate numeric,
  revenue_total numeric,
  revenue_per_lead numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() is distinct from 'service_role'
     and p_org_id is distinct from get_user_org_id() then
    raise exception 'automation_outcomes: organization mismatch';
  end if;

  if p_to <= p_from or p_to - p_from > interval '400 days' then
    raise exception 'automation_outcomes: invalid window';
  end if;

  return query
  with touched as (
    -- Who messaged each lead inside the window (outbound only).
    select
      m.lead_id,
      bool_or(m.sender_type = 'ai') as had_ai,
      bool_or(m.sender_type = 'user') as had_human
    from messages m
    where m.organization_id = p_org_id
      and m.created_at >= p_from and m.created_at < p_to
      and m.direction = 'outbound'
      and m.sender_type in ('ai', 'user')
      and m.lead_id is not null
    group by m.lead_id
  )
  select
    case
      when t.had_ai and t.had_human then 'mixed'
      when t.had_ai then 'ai'
      else 'human'
    end as o_lane,
    count(*)::bigint as n_touched,
    count(*) filter (
      where l.converted_at >= p_from and l.converted_at < p_to
    )::bigint as n_converted,
    round(
      count(*) filter (where l.converted_at >= p_from and l.converted_at < p_to)::numeric
        / count(*),
      4
    ) as conv_rate,
    round(coalesce(sum(l.actual_revenue) filter (
      where l.converted_at >= p_from and l.converted_at < p_to
    ), 0)::numeric, 2) as rev_total,
    round(coalesce(sum(l.actual_revenue) filter (
      where l.converted_at >= p_from and l.converted_at < p_to
    ), 0)::numeric / count(*), 2) as rev_per_lead
  from touched t
  join leads l on l.id = t.lead_id
  group by 1;
end;
$$;

comment on function public.automation_outcomes(uuid, timestamptz, timestamptz) is
  'Touch-based (NOT causal) conversion + revenue by lane: a lead is ai/human/mixed by which sender types messaged it in-window; conversions/revenue = converted_at + actual_revenue inside the same window. Org-guarded security definer.';

grant execute on function public.automation_outcomes(uuid, timestamptz, timestamptz)
  to authenticated, service_role;
