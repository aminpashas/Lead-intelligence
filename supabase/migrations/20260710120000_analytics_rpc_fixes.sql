-- Analytics RPC fixes — reconciles the analytics dashboard's RPC dependencies
-- with production. Migration 012 defined these functions but was never applied
-- to prod: get_response_time_metrics and get_pipeline_velocity did not exist,
-- so the route silently fell back to empty for those sections.
--
-- Changes vs 012:
--   * get_response_time_metrics — first-contact latency now only counts outbound
--     messages sent AT/AFTER the lead was created. Imported conversation history
--     carries messages that predate the lead record, which otherwise yielded
--     large NEGATIVE "first contact" times (and a bogus 99.9% "under 5 min").
--   * get_pipeline_velocity — broadened the transition activity_type filter to
--     ('status_changed','stage_changed','stage_advanced') and skips rows without
--     a destination stage in metadata->>'to'. (Most stage_changed rows currently
--     record no destination, so this section stays empty until stage-transition
--     logging captures the target stage — tracked separately.)
--   * get_source_roi — canonical status-based definition (no won_at column).
--
-- All three are STABLE, read-only reporting functions: no schema or data change.

create or replace function get_response_time_metrics(
  p_org_id uuid,
  p_start timestamptz default now() - interval '30 days',
  p_end timestamptz default now()
)
returns json as $$
declare result json;
begin
  select json_build_object(
    'avg_first_contact_minutes', coalesce(
      (select avg(extract(epoch from (first_msg.created_at - l.created_at)) / 60)
       from leads l
       cross join lateral (
         select m.created_at from messages m
         where m.lead_id = l.id and m.direction = 'outbound' and m.created_at >= l.created_at
         order by m.created_at asc limit 1
       ) first_msg
       where l.organization_id = p_org_id
         and l.created_at between p_start and p_end
         and first_msg.created_at is not null), 0),
    'avg_response_minutes', coalesce(
      (select avg(extract(epoch from (resp.created_at - inb.created_at)) / 60)
       from messages inb
       join leads l on l.id = inb.lead_id
       cross join lateral (
         select m.created_at from messages m
         where m.conversation_id = inb.conversation_id
           and m.direction = 'outbound' and m.created_at > inb.created_at
         order by m.created_at asc limit 1
       ) resp
       where l.organization_id = p_org_id
         and inb.direction = 'inbound'
         and inb.created_at between p_start and p_end), 0),
    'contacted_within_5min_pct', coalesce(
      (select round(
        count(*) filter (where extract(epoch from (first_msg.created_at - l.created_at)) <= 300) * 100.0 /
        nullif(count(*), 0), 1)
       from leads l
       cross join lateral (
         select m.created_at from messages m
         where m.lead_id = l.id and m.direction = 'outbound' and m.created_at >= l.created_at
         order by m.created_at asc limit 1
       ) first_msg
       where l.organization_id = p_org_id
         and l.created_at between p_start and p_end
         and first_msg.created_at is not null), 0),
    'distribution', (
      select coalesce(json_agg(json_build_object('bucket', bucket, 'count', cnt)), '[]'::json)
      from (
        select case
            when mins <= 5 then 'Under 5 min'
            when mins <= 15 then '5-15 min'
            when mins <= 60 then '15-60 min'
            when mins <= 1440 then '1-24 hours'
            else 'Over 24 hours' end as bucket,
          count(*) as cnt
        from (
          select extract(epoch from (first_msg.created_at - l.created_at)) / 60 as mins
          from leads l
          cross join lateral (
            select m.created_at from messages m
            where m.lead_id = l.id and m.direction = 'outbound' and m.created_at >= l.created_at
            order by m.created_at asc limit 1
          ) first_msg
          where l.organization_id = p_org_id
            and l.created_at between p_start and p_end
            and first_msg.created_at is not null
        ) t
        group by 1 order by min(mins)
      ) buckets)
  ) into result;
  return result;
end;
$$ language plpgsql stable;

create or replace function get_source_roi(
  p_org_id uuid,
  p_start timestamptz default now() - interval '30 days',
  p_end timestamptz default now()
)
returns json as $$
declare result json;
begin
  select coalesce(json_agg(row_to_json(t)), '[]'::json)
  from (
    select
      coalesce(source_type, 'unknown') as source,
      count(*) as lead_count,
      count(*) filter (where status in ('contract_signed', 'scheduled', 'in_treatment', 'completed')) as conversions,
      round(count(*) filter (where status in ('contract_signed', 'scheduled', 'in_treatment', 'completed')) * 100.0 /
        nullif(count(*), 0), 1) as conversion_rate,
      coalesce(sum(actual_revenue), 0) as total_revenue,
      coalesce(round(avg(actual_revenue) filter (where actual_revenue > 0)), 0) as avg_deal_size,
      coalesce(round(avg(ai_score)), 0) as avg_score
    from leads
    where organization_id = p_org_id and created_at between p_start and p_end
    group by source_type
    order by total_revenue desc, lead_count desc
  ) t into result;
  return result;
end;
$$ language plpgsql stable;

create or replace function get_pipeline_velocity(
  p_org_id uuid,
  p_start timestamptz default now() - interval '90 days',
  p_end timestamptz default now()
)
returns json as $$
declare result json;
begin
  select coalesce(json_agg(row_to_json(t)), '[]'::json)
  from (
    select
      la.metadata->>'to' as stage,
      count(*) as transitions,
      round(avg(extract(epoch from (lead_lateral.next_change - la.created_at)) / 86400), 1) as avg_days_in_stage
    from lead_activities la
    join leads l on l.id = la.lead_id
    cross join lateral (
      select la2.created_at as next_change
      from lead_activities la2
      where la2.lead_id = la.lead_id
        and la2.activity_type in ('status_changed','stage_changed','stage_advanced')
        and la2.created_at > la.created_at
      order by la2.created_at asc limit 1
    ) lead_lateral
    where l.organization_id = p_org_id
      and la.activity_type in ('status_changed','stage_changed','stage_advanced')
      and la.metadata->>'to' is not null
      and la.created_at between p_start and p_end
    group by la.metadata->>'to'
    order by avg_days_in_stage desc
  ) t into result;
  return result;
end;
$$ language plpgsql stable;
