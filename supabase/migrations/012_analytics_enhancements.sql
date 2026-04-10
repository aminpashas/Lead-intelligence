-- Migration 012: Analytics Enhancements
-- New RPC functions for response time metrics, source ROI, and pipeline velocity.

-- ═══════════════════════════════════════════════════════════════
-- 1. RESPONSE TIME METRICS
-- ═══════════════════════════════════════════════════════════════

create or replace function get_response_time_metrics(
  p_org_id uuid,
  p_start timestamptz default now() - interval '30 days',
  p_end timestamptz default now()
)
returns json as $$
declare
  result json;
begin
  select json_build_object(
    'avg_first_contact_minutes', coalesce(
      (select avg(extract(epoch from (first_msg.created_at - l.created_at)) / 60)
       from leads l
       cross join lateral (
         select m.created_at
         from messages m
         where m.lead_id = l.id and m.direction = 'outbound'
         order by m.created_at asc limit 1
       ) first_msg
       where l.organization_id = p_org_id
         and l.created_at between p_start and p_end
         and first_msg.created_at is not null
      ), 0),
    'avg_response_minutes', coalesce(
      (select avg(extract(epoch from (resp.created_at - inb.created_at)) / 60)
       from messages inb
       join leads l on l.id = inb.lead_id
       cross join lateral (
         select m.created_at
         from messages m
         where m.conversation_id = inb.conversation_id
           and m.direction = 'outbound'
           and m.created_at > inb.created_at
         order by m.created_at asc limit 1
       ) resp
       where l.organization_id = p_org_id
         and inb.direction = 'inbound'
         and inb.created_at between p_start and p_end
      ), 0),
    'contacted_within_5min_pct', coalesce(
      (select round(
        count(*) filter (where extract(epoch from (first_msg.created_at - l.created_at)) <= 300) * 100.0 /
        nullif(count(*), 0)
      , 1)
       from leads l
       cross join lateral (
         select m.created_at
         from messages m
         where m.lead_id = l.id and m.direction = 'outbound'
         order by m.created_at asc limit 1
       ) first_msg
       where l.organization_id = p_org_id
         and l.created_at between p_start and p_end
      ), 0),
    'distribution', (
      select json_agg(json_build_object('bucket', bucket, 'count', cnt))
      from (
        select
          case
            when mins <= 5 then 'Under 5 min'
            when mins <= 15 then '5-15 min'
            when mins <= 60 then '15-60 min'
            when mins <= 1440 then '1-24 hours'
            else 'Over 24 hours'
          end as bucket,
          count(*) as cnt
        from (
          select extract(epoch from (first_msg.created_at - l.created_at)) / 60 as mins
          from leads l
          cross join lateral (
            select m.created_at
            from messages m
            where m.lead_id = l.id and m.direction = 'outbound'
            order by m.created_at asc limit 1
          ) first_msg
          where l.organization_id = p_org_id
            and l.created_at between p_start and p_end
        ) t
        group by 1
        order by min(mins)
      ) buckets
    )
  ) into result;

  return result;
end;
$$ language plpgsql stable;

-- ═══════════════════════════════════════════════════════════════
-- 2. SOURCE ROI
-- ═══════════════════════════════════════════════════════════════

create or replace function get_source_roi(
  p_org_id uuid,
  p_start timestamptz default now() - interval '30 days',
  p_end timestamptz default now()
)
returns json as $$
declare
  result json;
begin
  select coalesce(json_agg(row_to_json(t)), '[]'::json)
  from (
    select
      coalesce(source_type, 'unknown') as source,
      count(*) as lead_count,
      count(*) filter (where status in ('contract_signed', 'scheduled', 'in_treatment', 'completed')) as conversions,
      round(
        count(*) filter (where status in ('contract_signed', 'scheduled', 'in_treatment', 'completed')) * 100.0 /
        nullif(count(*), 0)
      , 1) as conversion_rate,
      coalesce(sum(actual_revenue), 0) as total_revenue,
      coalesce(round(avg(actual_revenue) filter (where actual_revenue > 0)), 0) as avg_deal_size,
      coalesce(round(avg(ai_score)), 0) as avg_score
    from leads
    where organization_id = p_org_id
      and created_at between p_start and p_end
    group by source_type
    order by total_revenue desc, lead_count desc
  ) t
  into result;

  return result;
end;
$$ language plpgsql stable;

-- ═══════════════════════════════════════════════════════════════
-- 3. PIPELINE VELOCITY
-- ═══════════════════════════════════════════════════════════════

create or replace function get_pipeline_velocity(
  p_org_id uuid,
  p_start timestamptz default now() - interval '90 days',
  p_end timestamptz default now()
)
returns json as $$
declare
  result json;
begin
  select coalesce(json_agg(row_to_json(t)), '[]'::json)
  from (
    select
      la.metadata->>'to' as stage,
      count(*) as transitions,
      round(avg(
        extract(epoch from (
          lead_lateral.next_change - la.created_at
        )) / 86400
      ), 1) as avg_days_in_stage
    from lead_activities la
    join leads l on l.id = la.lead_id
    cross join lateral (
      select la2.created_at as next_change
      from lead_activities la2
      where la2.lead_id = la.lead_id
        and la2.activity_type = 'status_changed'
        and la2.created_at > la.created_at
      order by la2.created_at asc limit 1
    ) lead_lateral
    where l.organization_id = p_org_id
      and la.activity_type = 'status_changed'
      and la.created_at between p_start and p_end
    group by la.metadata->>'to'
    order by avg_days_in_stage desc
  ) t
  into result;

  return result;
end;
$$ language plpgsql stable;

-- ═══════════════════════════════════════════════════════════════
-- 4. DATE-RANGE AWARE KPI FUNCTION (replaces hardcoded 30 days)
-- ═══════════════════════════════════════════════════════════════

create or replace function get_lead_kpis_ranged(
  p_org_id uuid,
  p_start timestamptz default now() - interval '30 days',
  p_end timestamptz default now()
)
returns json as $$
declare
  result json;
begin
  select json_build_object(
    'total_leads', count(*),
    'hot_leads', count(*) filter (where ai_qualification = 'hot'),
    'warm_leads', count(*) filter (where ai_qualification = 'warm'),
    'cold_leads', count(*) filter (where ai_qualification = 'cold'),
    'qualified_leads', count(*) filter (where status in ('qualified', 'consultation_scheduled', 'consultation_completed', 'treatment_presented', 'financing', 'contract_sent', 'contract_signed', 'scheduled', 'in_treatment', 'completed')),
    'converted_leads', count(*) filter (where status in ('contract_signed', 'scheduled', 'in_treatment', 'completed')),
    'total_pipeline', coalesce(sum(treatment_value) filter (where status not in ('lost', 'disqualified', 'completed')), 0),
    'total_revenue', coalesce(sum(actual_revenue), 0),
    'avg_score', coalesce(round(avg(ai_score) filter (where ai_score > 0)), 0),
    'new_in_period', count(*) filter (where created_at between p_start and p_end)
  )
  from leads
  where organization_id = p_org_id
  into result;

  return result;
end;
$$ language plpgsql stable;

-- ═══════════════════════════════════════════════════════════════
-- 5. DATE-RANGE AWARE TREND FUNCTION
-- ═══════════════════════════════════════════════════════════════

create or replace function get_lead_trend_ranged(
  p_org_id uuid,
  p_start timestamptz default now() - interval '30 days',
  p_end timestamptz default now()
)
returns json as $$
declare
  result json;
begin
  select coalesce(json_agg(row_to_json(t) order by t.date), '[]'::json)
  from (
    select
      d::date as date,
      count(l.id) filter (where l.created_at::date = d::date) as leads,
      count(l.id) filter (where l.status in ('contract_signed', 'scheduled', 'in_treatment', 'completed') and l.updated_at::date = d::date) as conversions
    from generate_series(p_start::date, p_end::date, '1 day'::interval) d
    left join leads l on l.organization_id = p_org_id and l.created_at::date = d::date
    group by d::date
  ) t
  into result;

  return result;
end;
$$ language plpgsql stable;
