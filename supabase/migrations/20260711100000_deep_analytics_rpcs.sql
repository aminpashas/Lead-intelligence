-- Deep Analytics RPCs — behavior-first analytics engine.
--
-- Context: ai_score/engagement_score are unpopulated for the bulk of imported
-- leads, so "quality" here is derived from observed behavior (replies,
-- conversation intent, consults, revenue) via analytics_lead_tier(). Spend
-- joins come from ad_metrics_daily (channel + campaign_name/campaign_id).
--
-- All functions are STABLE, read-only reporting functions scoped by
-- p_org_id. No schema or data changes beyond function definitions.

-- ── Behavioral quality tier ────────────────────────────────────────────────
-- Ordered ladder: converted > consult > disqualified > engaged > responded >
-- contacted > untouched. Disqualified outranks engagement tiers because a
-- worked-and-rejected lead is a stronger quality signal than reply counts.
create or replace function analytics_lead_tier(l leads) returns text
language sql immutable as $$
  select case
    when l.status::text in ('completed', 'in_treatment', 'contract_signed')
      or coalesce(l.actual_revenue, 0) > 0 then 'converted'
    when l.status::text in ('consultation_scheduled', 'consultation_completed',
      'treatment_presented', 'financing', 'contract_sent')
      or l.consultation_date is not null then 'consult'
    when l.status::text = 'disqualified' then 'disqualified'
    when coalesce(l.total_messages_received, 0) > 0
      and (l.conversation_intent::text in ('ready_to_book', 'considering', 'exploring')
        or coalesce(l.total_messages_received, 0) >= 2) then 'engaged'
    when coalesce(l.total_messages_received, 0) > 0 then 'responded'
    when l.last_contacted_at is not null
      or coalesce(l.total_messages_sent, 0) > 0
      or coalesce(l.total_emails_sent, 0) > 0
      or coalesce(l.total_sms_sent, 0) > 0 then 'contacted'
    else 'untouched'
  end
$$;

-- ── Quality tier distribution ──────────────────────────────────────────────
create or replace function get_quality_tiers(
  p_org_id uuid,
  p_start timestamptz default now() - interval '30 days',
  p_end timestamptz default now()
)
returns json as $$
declare result json;
begin
  select json_build_object(
    'tiers', coalesce((
      select json_agg(t order by t.rank)
      from (
        select
          analytics_lead_tier(l) as tier,
          min(case analytics_lead_tier(l)
            when 'converted' then 0 when 'consult' then 1 when 'engaged' then 2
            when 'responded' then 3 when 'contacted' then 4 when 'untouched' then 5
            else 6 end) as rank,
          count(*) as count,
          round(avg(coalesce(l.total_messages_sent, 0)), 1) as avg_outbound,
          round(avg(coalesce(l.total_messages_received, 0)), 1) as avg_inbound,
          sum(coalesce(l.actual_revenue, 0))::bigint as revenue,
          sum(coalesce(l.treatment_value, 0))::bigint as pipeline_value
        from leads l
        where l.organization_id = p_org_id
          and l.created_at between p_start and p_end
        group by analytics_lead_tier(l)
      ) t
    ), '[]'::json),
    'total', (select count(*) from leads l
      where l.organization_id = p_org_id and l.created_at between p_start and p_end)
  ) into result;
  return result;
end;
$$ language plpgsql stable;

-- ── Channel scorecard (attribution channel × behavior × spend) ─────────────
create or replace function get_channel_scorecard(
  p_org_id uuid,
  p_start timestamptz default now() - interval '30 days',
  p_end timestamptz default now()
)
returns json as $$
declare result json;
begin
  with base as (
    select
      coalesce(l.campaign_attribution->>'channel',
        'untagged_' || coalesce(l.source_type, 'unknown')) as channel,
      analytics_lead_tier(l) as tier,
      l.conversation_intent::text as intent,
      l.primary_objection::text as objection,
      coalesce(l.actual_revenue, 0) as revenue
    from leads l
    where l.organization_id = p_org_id
      and l.created_at between p_start and p_end
  ),
  spend as (
    select
      case a.channel when 'meta' then 'ppc_meta'
                     when 'google_ads' then 'ppc_google'
                     else a.channel end as channel,
      sum(a.spend) as spend,
      sum(a.clicks) as clicks,
      sum(a.impressions) as impressions
    from ad_metrics_daily a
    where a.organization_id = p_org_id
      and a.metric_date between p_start::date and p_end::date
    group by 1
  )
  select coalesce(json_agg(row_to_json(sc) order by sc.leads desc), '[]'::json)
  into result
  from (
    select
      b.channel,
      count(*) as leads,
      count(*) filter (where b.tier in ('responded', 'engaged', 'consult', 'converted')) as responded,
      count(*) filter (where b.tier in ('engaged', 'consult', 'converted')) as engaged,
      count(*) filter (where b.tier in ('consult', 'converted')) as consults,
      count(*) filter (where b.tier = 'converted') as converted,
      count(*) filter (where b.tier = 'disqualified') as disqualified,
      count(*) filter (where b.tier = 'untouched') as untouched,
      count(*) filter (where b.intent = 'ready_to_book') as ready_to_book,
      count(*) filter (where b.intent in ('resistant', 'disengaged')) as low_intent,
      count(*) filter (where b.objection = 'cost') as cost_objections,
      count(*) filter (where b.objection = 'financing') as financing_objections,
      sum(b.revenue)::bigint as revenue,
      s.spend::numeric(12,2) as spend,
      s.clicks,
      s.impressions,
      case when s.spend > 0 then round(s.spend / count(*), 2) end as cpl,
      case when s.spend > 0 and count(*) filter (where b.tier in ('engaged', 'consult', 'converted')) > 0
        then round(s.spend / count(*) filter (where b.tier in ('engaged', 'consult', 'converted')), 2) end as cost_per_engaged,
      case when s.spend > 0 and count(*) filter (where b.tier in ('consult', 'converted')) > 0
        then round(s.spend / count(*) filter (where b.tier in ('consult', 'converted')), 2) end as cost_per_consult
    from base b
    left join spend s on s.channel = b.channel
    group by b.channel, s.spend, s.clicks, s.impressions
  ) sc;
  return result;
end;
$$ language plpgsql stable;

-- ── Campaign scorecard (campaign × behavior × spend) ───────────────────────
-- Campaign key: campaign_attribution->>'campaign_name', falling back to
-- utm_campaign. Spend matches ad_metrics_daily on campaign_name OR
-- campaign_id (utm_campaign is often a numeric Google campaign id).
create or replace function get_campaign_scorecard(
  p_org_id uuid,
  p_start timestamptz default now() - interval '30 days',
  p_end timestamptz default now()
)
returns json as $$
declare result json;
begin
  with base as (
    select
      coalesce(l.campaign_attribution->>'campaign_name', nullif(l.utm_campaign, '')) as campaign,
      coalesce(l.campaign_attribution->>'channel', 'unknown') as channel,
      analytics_lead_tier(l) as tier,
      l.conversation_intent::text as intent,
      l.primary_objection::text as objection,
      coalesce(l.actual_revenue, 0) as revenue
    from leads l
    where l.organization_id = p_org_id
      and l.created_at between p_start and p_end
      and coalesce(l.campaign_attribution->>'campaign_name', nullif(l.utm_campaign, '')) is not null
  ),
  spend as (
    select a.campaign_name,
           max(a.campaign_id::text) as campaign_id,
           sum(a.spend) as spend,
           sum(a.clicks) as clicks,
           sum(a.impressions) as impressions
    from ad_metrics_daily a
    where a.organization_id = p_org_id
      and a.metric_date between p_start::date and p_end::date
    group by a.campaign_name
  )
  select coalesce(json_agg(row_to_json(sc) order by sc.leads desc), '[]'::json)
  into result
  from (
    select
      b.campaign,
      max(b.channel) as channel,
      count(*) as leads,
      count(*) filter (where b.tier in ('responded', 'engaged', 'consult', 'converted')) as responded,
      count(*) filter (where b.tier in ('engaged', 'consult', 'converted')) as engaged,
      count(*) filter (where b.tier in ('consult', 'converted')) as consults,
      count(*) filter (where b.tier = 'converted') as converted,
      count(*) filter (where b.tier = 'disqualified') as disqualified,
      count(*) filter (where b.intent = 'ready_to_book') as ready_to_book,
      count(*) filter (where b.objection = 'cost') as cost_objections,
      count(*) filter (where b.objection = 'financing') as financing_objections,
      sum(b.revenue)::bigint as revenue,
      max(s.spend)::numeric(12,2) as spend,
      case when max(s.spend) > 0 then round(max(s.spend) / count(*), 2) end as cpl,
      case when max(s.spend) > 0 and count(*) filter (where b.tier in ('engaged', 'consult', 'converted')) > 0
        then round(max(s.spend) / count(*) filter (where b.tier in ('engaged', 'consult', 'converted')), 2) end as cost_per_engaged
    from base b
    left join spend s on s.campaign_name = b.campaign or s.campaign_id = b.campaign
    group by b.campaign
  ) sc;
  return result;
end;
$$ language plpgsql stable;

-- Spend rows with no matching lead campaign (spend leaking with zero
-- attributed leads) — surfaced separately so wasted/untracked spend is visible.
create or replace function get_unattributed_spend(
  p_org_id uuid,
  p_start timestamptz default now() - interval '30 days',
  p_end timestamptz default now()
)
returns json as $$
declare result json;
begin
  with lead_campaigns as (
    select distinct coalesce(l.campaign_attribution->>'campaign_name', nullif(l.utm_campaign, '')) as campaign
    from leads l
    where l.organization_id = p_org_id
      and l.created_at between p_start and p_end
  ),
  agg as (
    select a.campaign_name, a.channel,
           max(a.campaign_id::text) as campaign_id,
           sum(a.spend) as spend,
           sum(a.clicks) as clicks,
           sum(a.conversions)::int as platform_conversions
    from ad_metrics_daily a
    where a.organization_id = p_org_id
      and a.metric_date between p_start::date and p_end::date
    group by a.campaign_name, a.channel
  )
  select coalesce(json_agg(row_to_json(t) order by t.spend desc), '[]'::json)
  into result
  from (
    select agg.campaign_name, agg.channel,
           agg.spend::numeric(12,2) as spend, agg.clicks, agg.platform_conversions
    from agg
    where agg.spend > 0
      and not exists (
        select 1 from lead_campaigns lc
        where lc.campaign = agg.campaign_name or lc.campaign = agg.campaign_id
      )
  ) t;
  return result;
end;
$$ language plpgsql stable;

-- ── Speed-to-lead vs outcome ───────────────────────────────────────────────
-- First outbound message latency (only messages at/after lead creation, to
-- exclude imported history) bucketed, with the response rate per bucket —
-- the evidence base for the "5-minute rule".
create or replace function get_speed_to_lead(
  p_org_id uuid,
  p_start timestamptz default now() - interval '30 days',
  p_end timestamptz default now()
)
returns json as $$
declare result json;
begin
  with firsts as (
    select
      l.id,
      extract(epoch from (fm.created_at - l.created_at)) / 60 as minutes,
      (coalesce(l.total_messages_received, 0) > 0) as responded,
      analytics_lead_tier(l) in ('consult', 'converted') as reached_consult
    from leads l
    left join lateral (
      select m.created_at from messages m
      where m.lead_id = l.id and m.direction = 'outbound'
        and m.created_at >= l.created_at
      order by m.created_at asc limit 1
    ) fm on true
    where l.organization_id = p_org_id
      and l.created_at between p_start and p_end
  ),
  bucketed as (
    select
      case
        when minutes is null then 'never'
        when minutes <= 5 then '0-5m'
        when minutes <= 15 then '5-15m'
        when minutes <= 60 then '15-60m'
        when minutes <= 240 then '1-4h'
        when minutes <= 1440 then '4-24h'
        else '24h+'
      end as bucket,
      case
        when minutes is null then 6
        when minutes <= 5 then 0 when minutes <= 15 then 1 when minutes <= 60 then 2
        when minutes <= 240 then 3 when minutes <= 1440 then 4 else 5
      end as rank,
      responded, reached_consult
    from firsts
  )
  select json_build_object(
    'buckets', coalesce((
      select json_agg(t order by t.rank)
      from (
        select bucket, min(rank) as rank, count(*) as leads,
               count(*) filter (where responded) as responded,
               round(100.0 * count(*) filter (where responded) / count(*), 1) as response_rate,
               round(100.0 * count(*) filter (where reached_consult) / count(*), 1) as consult_rate
        from bucketed group by bucket
      ) t
    ), '[]'::json),
    'median_minutes', (select round(percentile_cont(0.5) within group (order by minutes)::numeric, 1)
      from firsts where minutes is not null),
    'pct_within_5min', (select round(100.0 * count(*) filter (where minutes <= 5) /
      greatest(count(*), 1), 1) from firsts),
    'never_contacted', (select count(*) from firsts where minutes is null)
  ) into result;
  return result;
end;
$$ language plpgsql stable;

-- ── Engagement funnel: attempts, channel effectiveness, AI vs human ────────
create or replace function get_engagement_funnel(
  p_org_id uuid,
  p_start timestamptz default now() - interval '30 days',
  p_end timestamptz default now()
)
returns json as $$
declare result json;
begin
  with lead_msgs as (
    select l.id as lead_id, l.created_at as lead_created,
      (select min(m.created_at) from messages m
        where m.lead_id = l.id and m.direction = 'inbound'
          and m.created_at >= l.created_at) as first_inbound
    from leads l
    where l.organization_id = p_org_id
      and l.created_at between p_start and p_end
  ),
  attempts as (
    select lm.lead_id,
      (select count(*) from messages m
        where m.lead_id = lm.lead_id and m.direction = 'outbound'
          and m.created_at >= lm.lead_created
          and m.created_at < lm.first_inbound) as touches_before_reply
    from lead_msgs lm
    where lm.first_inbound is not null
  )
  select json_build_object(
    'touches_to_first_reply', coalesce((
      select json_agg(t order by t.rank)
      from (
        select
          case when touches_before_reply = 0 then 'inbound-first'
               when touches_before_reply >= 5 then '5+'
               else touches_before_reply::text end as touches,
          least(touches_before_reply, 5) as rank,
          count(*) as leads
        from attempts group by 1, 2
      ) t
    ), '[]'::json),
    'channel_effectiveness', coalesce((
      select json_agg(row_to_json(t) order by t.outbound desc)
      from (
        select m.channel,
          count(*) filter (where m.direction = 'outbound') as outbound,
          count(distinct m.lead_id) filter (where m.direction = 'outbound') as leads_contacted,
          count(*) filter (where m.direction = 'inbound') as inbound,
          count(distinct m.lead_id) filter (where m.direction = 'inbound') as leads_responded,
          round(100.0 * count(distinct m.lead_id) filter (where m.direction = 'inbound') /
            greatest(count(distinct m.lead_id) filter (where m.direction = 'outbound'), 1), 1) as lead_reply_rate
        from messages m
        where m.organization_id = p_org_id
          and m.created_at between p_start and p_end
        group by m.channel
      ) t
    ), '[]'::json),
    -- replied_at is only stamped for email opens; SMS replies never set it.
    -- A message "got a reply" iff its conversation has a LATER inbound message.
    'ai_vs_human', (
      with inb as (
        select conversation_id, max(created_at) as last_inbound
        from messages
        where organization_id = p_org_id and direction = 'inbound'
        group by conversation_id
      )
      select json_build_object(
        'ai_sent', count(*) filter (where m.ai_generated),
        'ai_replied', count(*) filter (where m.ai_generated and inb.last_inbound > m.created_at),
        'human_sent', count(*) filter (where not m.ai_generated),
        'human_replied', count(*) filter (where not m.ai_generated and inb.last_inbound > m.created_at)
      )
      from messages m
      left join inb on inb.conversation_id = m.conversation_id
      where m.organization_id = p_org_id and m.direction = 'outbound'
        and m.created_at between p_start and p_end
    )
  ) into result;
  return result;
end;
$$ language plpgsql stable;

-- ── Contact heatmap (lead creation + inbound replies, practice timezone) ───
create or replace function get_contact_heatmap(
  p_org_id uuid,
  p_start timestamptz default now() - interval '30 days',
  p_end timestamptz default now(),
  p_tz text default 'America/Los_Angeles'
)
returns json as $$
declare result json;
begin
  select json_build_object(
    'lead_created', coalesce((
      select json_agg(row_to_json(t))
      from (
        select extract(dow from l.created_at at time zone p_tz)::int as dow,
               extract(hour from l.created_at at time zone p_tz)::int as hour,
               count(*) as count
        from leads l
        where l.organization_id = p_org_id and l.created_at between p_start and p_end
        group by 1, 2
      ) t
    ), '[]'::json),
    'inbound_messages', coalesce((
      select json_agg(row_to_json(t))
      from (
        select extract(dow from m.created_at at time zone p_tz)::int as dow,
               extract(hour from m.created_at at time zone p_tz)::int as hour,
               count(*) as count
        from messages m
        where m.organization_id = p_org_id and m.direction = 'inbound'
          and m.created_at between p_start and p_end
        group by 1, 2
      ) t
    ), '[]'::json)
  ) into result;
  return result;
end;
$$ language plpgsql stable;

-- ── Conversion lag (created → consult / converted) ─────────────────────────
create or replace function get_conversion_lag(
  p_org_id uuid,
  p_start timestamptz default now() - interval '90 days',
  p_end timestamptz default now()
)
returns json as $$
declare result json;
begin
  select json_build_object(
    'to_consult_days_median', (
      select round(percentile_cont(0.5) within group (
        order by extract(epoch from (l.consultation_date - l.created_at)) / 86400)::numeric, 1)
      from leads l
      where l.organization_id = p_org_id and l.created_at between p_start and p_end
        and l.consultation_date is not null and l.consultation_date > l.created_at),
    'to_consult_count', (
      select count(*) from leads l
      where l.organization_id = p_org_id and l.created_at between p_start and p_end
        and l.consultation_date is not null),
    'to_converted_days_median', (
      select round(percentile_cont(0.5) within group (
        order by extract(epoch from (l.converted_at - l.created_at)) / 86400)::numeric, 1)
      from leads l
      where l.organization_id = p_org_id and l.created_at between p_start and p_end
        and l.converted_at is not null and l.converted_at > l.created_at),
    'to_converted_count', (
      select count(*) from leads l
      where l.organization_id = p_org_id and l.created_at between p_start and p_end
        and l.converted_at is not null)
  ) into result;
  return result;
end;
$$ language plpgsql stable;

-- ── Action queue (worklists behind the recommendations) ────────────────────
create or replace function get_action_queue(p_org_id uuid)
returns json as $$
declare result json;
begin
  select json_build_object(
    'untouched_new', (
      select count(*) from leads l
      where l.organization_id = p_org_id
        and l.status::text = 'new'
        and analytics_lead_tier(l) = 'untouched'
        and l.created_at < now() - interval '1 day'),
    'ready_to_book_stale', (
      select count(*) from leads l
      where l.organization_id = p_org_id
        and l.conversation_intent::text = 'ready_to_book'
        and l.status::text not in ('completed', 'disqualified', 'consultation_scheduled', 'consultation_completed')
        and coalesce(l.last_contacted_at, l.created_at) < now() - interval '48 hours'),
    'inbound_awaiting_reply', (
      select count(*) from leads l
      where l.organization_id = p_org_id
        and l.last_responded_at is not null
        and (l.last_contacted_at is null or l.last_responded_at > l.last_contacted_at)
        and l.last_responded_at > now() - interval '14 days'
        and l.status::text not in ('completed', 'disqualified')),
    'engaged_gone_quiet', (
      select count(*) from leads l
      where l.organization_id = p_org_id
        and l.conversation_intent::text in ('considering', 'exploring')
        and l.last_responded_at < now() - interval '7 days'
        and l.status::text not in ('completed', 'disqualified', 'consultation_scheduled')),
    'samples', json_build_object(
      'ready_to_book_stale', coalesce((
        select json_agg(json_build_object('id', l.id, 'name',
          coalesce(nullif(trim(coalesce(l.first_name, '') || ' ' || coalesce(l.last_name, '')), ''), 'Unknown'),
          'last_contacted', l.last_contacted_at))
        from (
          select * from leads l
          where l.organization_id = p_org_id
            and l.conversation_intent::text = 'ready_to_book'
            and l.status::text not in ('completed', 'disqualified', 'consultation_scheduled', 'consultation_completed')
            and coalesce(l.last_contacted_at, l.created_at) < now() - interval '48 hours'
          order by l.created_at desc limit 8
        ) l
      ), '[]'::json)
    )
  ) into result;
  return result;
end;
$$ language plpgsql stable;

-- ── Tracking / data-quality coverage ───────────────────────────────────────
create or replace function get_tracking_coverage(
  p_org_id uuid,
  p_start timestamptz default now() - interval '30 days',
  p_end timestamptz default now()
)
returns json as $$
declare result json;
begin
  with base as (
    select l.*, coalesce(l.campaign_attribution->>'channel', 'unknown') as ch
    from leads l
    where l.organization_id = p_org_id and l.created_at between p_start and p_end
  )
  select json_build_object(
    'total', (select count(*) from base),
    'with_channel', (select count(*) from base where campaign_attribution is not null),
    'with_utm_source', (select count(*) from base where utm_source is not null),
    'with_utm_campaign', (select count(*) from base where utm_campaign is not null),
    'paid_leads', (select count(*) from base where ch in ('ppc_meta', 'ppc_google')),
    'paid_with_campaign_name', (select count(*) from base
      where ch in ('ppc_meta', 'ppc_google')
        and coalesce(campaign_attribution->>'campaign_name', nullif(utm_campaign, '')) is not null),
    'google_with_gclid', (select count(*) from base where ch = 'ppc_google' and gclid is not null),
    'meta_with_fbclid', (select count(*) from base where ch = 'ppc_meta' and fbclid is not null),
    'ai_scored', (select count(*) from base where ai_score > 0),
    'conversation_analyzed', (select count(*) from base where conversation_analyzed_at is not null),
    'direct_share', (select round(100.0 * count(*) filter (where ch = 'direct') / greatest(count(*), 1), 1) from base)
  ) into result;
  return result;
end;
$$ language plpgsql stable;

-- ── Intent / sentiment / objection distributions (conversation sweep) ──────
create or replace function get_intent_objections(
  p_org_id uuid,
  p_start timestamptz default now() - interval '30 days',
  p_end timestamptz default now()
)
returns json as $$
declare result json;
begin
  select json_build_object(
    'analyzed', (select count(*) from leads l
      where l.organization_id = p_org_id and l.created_at between p_start and p_end
        and l.conversation_analyzed_at is not null),
    'intent', coalesce((
      select json_agg(t order by t.n desc)
      from (select l.conversation_intent::text as intent, count(*) as n
        from leads l
        where l.organization_id = p_org_id and l.created_at between p_start and p_end
          and l.conversation_intent is not null
        group by 1) t
    ), '[]'::json),
    'sentiment', coalesce((
      select json_agg(t order by t.n desc)
      from (select l.conversation_sentiment::text as sentiment, count(*) as n
        from leads l
        where l.organization_id = p_org_id and l.created_at between p_start and p_end
          and l.conversation_sentiment is not null
        group by 1) t
    ), '[]'::json),
    'objections', coalesce((
      select json_agg(t order by t.n desc)
      from (select l.primary_objection::text as objection, count(*) as n
        from leads l
        where l.organization_id = p_org_id and l.created_at between p_start and p_end
          and l.primary_objection is not null and l.primary_objection::text <> 'none'
        group by 1) t
    ), '[]'::json),
    'red_flags', (select count(*) from leads l
      where l.organization_id = p_org_id and l.created_at between p_start and p_end
        and l.conversation_red_flag)
  ) into result;
  return result;
end;
$$ language plpgsql stable;
