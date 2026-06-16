-- Grade agents on real treatment outcomes.
--
-- Adds a graded KPI `treatment_success_rate` = share of an agent's attributed
-- treatment_outcomes that were 'success'. Attribution reuses the same model every
-- other KPI uses — the agent sent at least one AI message to the outcome's lead —
-- so BOTH the setter and the closer who worked a lead are measured on its outcome.
--
-- The "weighting" of setter vs closer is expressed through role-differentiated
-- targets: the closer (more causally responsible for case quality) is held to a
-- higher bar than the setter. Targets can still be tuned per-agent later.
--
-- Three parts:
--   1. extend the new-org seed trigger to seed the KPI's targets,
--   2. backfill targets for existing agents,
--   3. extend get_agent_kpi_summary to compute the KPI per agent.

-- ── 1. New-org seed: add treatment_success_rate targets ────────────────────────
create or replace function public.seed_default_agents_for_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  setter_id uuid;
  closer_id uuid;
begin
  insert into ai_agents (organization_id, name, role, persona_description)
  values (new.id, 'Default Setter', 'setter',
          'Handles initial outreach, qualification, and consultation booking.')
  returning id into setter_id;

  insert into ai_agents (organization_id, name, role, persona_description)
  values (new.id, 'Default Closer', 'closer',
          'Handles post-consultation treatment coordination, financing, and close.')
  returning id into closer_id;

  insert into agent_kpi_targets (agent_id, organization_id, kpi_name, target_value, warning_threshold, critical_threshold, direction)
  values
    (setter_id, new.id, 'contact_rate',          80, 70, 60, 'higher_is_better'),
    (setter_id, new.id, 'avg_call_rating',       4.0, 3.5, 3.0, 'higher_is_better'),
    (setter_id, new.id, 'booking_rate',          30, 22, 15, 'higher_is_better'),
    (setter_id, new.id, 'no_show_rate',          20, 25, 35, 'lower_is_better'),
    (setter_id, new.id, 'reschedule_rate',       15, 20, 30, 'lower_is_better'),
    (setter_id, new.id, 'qualification_rate',    50, 40, 30, 'higher_is_better'),
    (setter_id, new.id, 'follow_up_rate',        70, 55, 40, 'higher_is_better'),
    (setter_id, new.id, 'leads_went_cold_rate',  25, 30, 40, 'lower_is_better'),
    (setter_id, new.id, 'no_communication_rate', 20, 25, 35, 'lower_is_better'),
    (setter_id, new.id, 'avg_response_minutes',  5, 10, 15, 'lower_is_better'),
    -- setter is weighted lower on case outcome (less causally responsible)
    (setter_id, new.id, 'treatment_success_rate', 75, 65, 50, 'higher_is_better'),
    (closer_id, new.id, 'contact_rate',          80, 70, 60, 'higher_is_better'),
    (closer_id, new.id, 'avg_call_rating',       4.0, 3.5, 3.0, 'higher_is_better'),
    (closer_id, new.id, 'booking_rate',          30, 22, 15, 'higher_is_better'),
    (closer_id, new.id, 'no_show_rate',          20, 25, 35, 'lower_is_better'),
    (closer_id, new.id, 'reschedule_rate',       15, 20, 30, 'lower_is_better'),
    (closer_id, new.id, 'qualification_rate',    50, 40, 30, 'higher_is_better'),
    (closer_id, new.id, 'follow_up_rate',        70, 55, 40, 'higher_is_better'),
    (closer_id, new.id, 'leads_went_cold_rate',  25, 30, 40, 'lower_is_better'),
    (closer_id, new.id, 'no_communication_rate', 20, 25, 35, 'lower_is_better'),
    (closer_id, new.id, 'avg_response_minutes',  5, 10, 15, 'lower_is_better'),
    -- closer is held to a stricter bar on case outcome
    (closer_id, new.id, 'treatment_success_rate', 85, 75, 60, 'higher_is_better');

  return new;
end;
$$;

-- ── 2. Backfill existing agents (role-differentiated, idempotent) ──────────────
insert into agent_kpi_targets (agent_id, organization_id, kpi_name, target_value, warning_threshold, critical_threshold, direction)
select a.id, a.organization_id, 'treatment_success_rate',
       case a.role when 'closer' then 85 else 75 end,
       case a.role when 'closer' then 75 else 65 end,
       case a.role when 'closer' then 60 else 50 end,
       'higher_is_better'
from ai_agents a
where a.role in ('setter', 'closer')
on conflict (agent_id, kpi_name) do nothing;

-- ── 3. Extend get_agent_kpi_summary with the treatment_success_rate KPI ────────
create or replace function public.get_agent_kpi_summary(
  p_org_id uuid,
  p_start timestamp with time zone default (now() - '30 days'::interval),
  p_end timestamp with time zone default now(),
  p_agent_id uuid default null::uuid
)
returns json
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  result json;
begin
  with agents as (
    select id, name, role, is_active
      from ai_agents
     where organization_id = p_org_id
       and is_active = true
       and (p_agent_id is null or id = p_agent_id)
  ),
  stats as (
    select
      a.id as agent_id,
      a.name,
      a.role,
      (select count(distinct m.lead_id) from messages m
        where m.agent_id = a.id and m.direction = 'outbound' and m.sender_type = 'ai'
          and m.created_at between p_start and p_end) as attributed_leads,
      (select count(distinct m.lead_id) from messages m
        where m.agent_id = a.id and m.direction = 'outbound' and m.sender_type = 'ai'
          and m.created_at between p_start and p_end
          and exists (
            select 1 from messages r
             where r.lead_id = m.lead_id
               and r.direction = 'inbound'
               and r.created_at between p_start and p_end
          )) as replied_leads,
      (select avg(r.rating)::numeric(4,2) from ai_conversation_ratings r
        join conversations c on c.id = r.conversation_id
        where r.organization_id = p_org_id
          and c.active_agent = a.role
          and r.created_at between p_start and p_end) as avg_call_rating,
      (select count(distinct ap.lead_id) from appointments ap
        where ap.organization_id = p_org_id
          and ap.type = 'consultation'
          and ap.created_at between p_start and p_end
          and exists (
            select 1 from messages m
             where m.lead_id = ap.lead_id and m.agent_id = a.id
               and m.created_at <= ap.created_at
          )) as booked_leads,
      (select count(*) from appointments ap
        where ap.organization_id = p_org_id
          and ap.status = 'no_show'
          and coalesce(ap.no_show_at, ap.scheduled_at) between p_start and p_end
          and exists (select 1 from messages m where m.lead_id = ap.lead_id and m.agent_id = a.id))
        as appts_no_show,
      (select count(*) from appointments ap
        where ap.organization_id = p_org_id
          and ap.status = 'completed'
          and ap.completed_at between p_start and p_end
          and exists (select 1 from messages m where m.lead_id = ap.lead_id and m.agent_id = a.id))
        as appts_completed,
      (select count(*) from appointments ap
        where ap.organization_id = p_org_id
          and ap.status = 'rescheduled'
          and ap.updated_at between p_start and p_end
          and exists (select 1 from messages m where m.lead_id = ap.lead_id and m.agent_id = a.id))
        as appts_rescheduled,
      (select count(*) from appointments ap
        where ap.organization_id = p_org_id
          and ap.status = 'canceled'
          and coalesce(ap.canceled_at, ap.updated_at) between p_start and p_end
          and exists (select 1 from messages m where m.lead_id = ap.lead_id and m.agent_id = a.id))
        as appts_canceled,
      (select count(distinct la.lead_id) from lead_activities la
        where la.organization_id = p_org_id
          and la.activity_type = 'qualified'
          and la.created_at between p_start and p_end
          and exists (select 1 from messages m where m.lead_id = la.lead_id and m.agent_id = a.id))
        as qualified_leads,
      (select count(distinct m1.lead_id)
         from messages m1
         join messages m2 on m2.lead_id = m1.lead_id
                         and m2.agent_id = a.id
                         and m2.direction = 'outbound'
                         and m2.sender_type = 'ai'
                         and m2.created_at >= m1.created_at + interval '24 hours'
                         and m2.created_at between p_start and p_end
        where m1.agent_id = a.id
          and m1.direction = 'outbound'
          and m1.sender_type = 'ai'
          and m1.created_at between p_start and p_end)
        as followup_leads,
      (select count(distinct m.lead_id) from messages m
        where m.agent_id = a.id and m.direction = 'outbound' and m.sender_type = 'ai'
          and m.created_at between p_start and p_end
          and not exists (
            select 1 from messages r
             where r.lead_id = m.lead_id and r.direction = 'inbound'
               and r.created_at between m.created_at and m.created_at + interval '24 hours'
          ))
        as unresponded_leads,
      (select count(distinct lm.lead_id)
         from (
           select m.lead_id, max(m.created_at) as last_at
             from messages m
            where m.agent_id = a.id and m.direction = 'outbound' and m.sender_type = 'ai'
              and m.created_at between p_start and p_end
            group by m.lead_id
         ) lm
         join leads l on l.id = lm.lead_id
        where lm.last_at < p_end - interval '14 days'
          and l.status not in ('completed','lost','disqualified','contract_signed','scheduled','in_treatment'))
        as cold_leads,
      (select count(distinct m.lead_id) from messages m
        where m.agent_id = a.id and m.direction = 'outbound' and m.sender_type = 'ai'
          and m.created_at between p_start and p_end
          and not exists (
            select 1 from messages r
             where r.lead_id = m.lead_id and r.direction = 'inbound'
          ))
        as no_comm_leads,
      (select
         case when sum(response_count) > 0
              then round((sum(response_total_seconds)::numeric / sum(response_count)) / 60, 1)
              else null end
         from agent_performance_daily
        where agent_id = a.id and date between p_start::date and p_end::date)
        as avg_response_minutes,
      coalesce((select round(sum(closed_revenue_cents)::numeric / 100, 2)
                  from agent_performance_daily
                 where agent_id = a.id and date between p_start::date and p_end::date), 0)
        as closed_revenue,
      coalesce((select round(sum(ai_cost_cents)::numeric / 100, 2)
                  from agent_performance_daily
                 where agent_id = a.id and date between p_start::date and p_end::date), 0)
        as total_ai_cost,
      (select count(distinct l.id) from leads l
        where l.organization_id = p_org_id
          and l.status in ('contract_signed','scheduled','in_treatment','completed')
          and l.converted_at between p_start and p_end
          and exists (select 1 from messages m where m.lead_id = l.id and m.agent_id = a.id))
        as converted_leads,
      -- Treatment outcomes attributed to this agent (agent ever messaged the lead),
      -- occurring in the window. Both setter and closer get measured on the outcome.
      (select count(*) from treatment_outcomes t
        where t.organization_id = p_org_id
          and t.occurred_at between p_start and p_end
          and exists (select 1 from messages m where m.lead_id = t.lead_id and m.agent_id = a.id))
        as outcomes_total,
      (select count(*) from treatment_outcomes t
        where t.organization_id = p_org_id
          and t.occurred_at between p_start and p_end
          and t.outcome = 'success'
          and exists (select 1 from messages m where m.lead_id = t.lead_id and m.agent_id = a.id))
        as outcomes_success
    from agents a
  )
  select json_agg(
    json_build_object(
      'id', agent_id,
      'name', name,
      'role', role,
      'kpis', json_build_object(
        'contact_rate',          case when attributed_leads > 0 then round(replied_leads::numeric * 100 / attributed_leads, 1) end,
        'avg_call_rating',       avg_call_rating,
        'booking_rate',          case when attributed_leads > 0 then round(booked_leads::numeric * 100 / attributed_leads, 1) end,
        'no_show_rate',          case when (appts_completed + appts_no_show) > 0
                                      then round(appts_no_show::numeric * 100 / (appts_completed + appts_no_show), 1) end,
        'reschedule_rate',       case when (appts_completed + appts_no_show + appts_rescheduled + appts_canceled) > 0
                                      then round(appts_rescheduled::numeric * 100 /
                                           (appts_completed + appts_no_show + appts_rescheduled + appts_canceled), 1) end,
        'qualification_rate',    case when attributed_leads > 0 then round(qualified_leads::numeric * 100 / attributed_leads, 1) end,
        'follow_up_rate',        case when unresponded_leads > 0 then round(followup_leads::numeric * 100 / unresponded_leads, 1) end,
        'leads_went_cold_rate',  case when attributed_leads > 0 then round(cold_leads::numeric * 100 / attributed_leads, 1) end,
        'no_communication_rate', case when attributed_leads > 0 then round(no_comm_leads::numeric * 100 / attributed_leads, 1) end,
        'treatment_success_rate', case when outcomes_total > 0 then round(outcomes_success::numeric * 100 / outcomes_total, 1) end,
        'avg_response_minutes',  avg_response_minutes,
        'closed_revenue',        closed_revenue,
        'cac_per_converted',     case when converted_leads > 0 then round(total_ai_cost / converted_leads, 2) end
      ),
      'raw', json_build_object(
        'attributed_leads', attributed_leads,
        'replied_leads', replied_leads,
        'booked_leads', booked_leads,
        'qualified_leads', qualified_leads,
        'followup_leads', followup_leads,
        'unresponded_leads', unresponded_leads,
        'cold_leads', cold_leads,
        'no_comm_leads', no_comm_leads,
        'appts_completed', appts_completed,
        'appts_no_show', appts_no_show,
        'appts_rescheduled', appts_rescheduled,
        'appts_canceled', appts_canceled,
        'total_ai_cost', total_ai_cost,
        'converted_leads', converted_leads,
        'outcomes_total', outcomes_total,
        'outcomes_success', outcomes_success
      )
    )
    order by case role when 'setter' then 1 when 'closer' then 2 else 3 end, name
  ) into result
  from stats;

  return coalesce(result, '[]'::json);
end;
$function$;
