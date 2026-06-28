-- ============================================================================
-- 20260627230000 — REMOTE BASELINE (Option A re-baseline)
-- ============================================================================
-- Single source-of-truth schema captured from production
-- (bnmnirzfwopqklsitjgq) via `supabase db dump --linked` on 2026-06-27, AFTER
-- the C1/R1/R2 audit fixes were applied. This is pg_dump output: dependency-
-- ordered and replayable on an empty database by construction.
--
-- It REPLACES the 79 hand-numbered legacy files now in ./_archive/ (see
-- _archive/README.md and docs/MIGRATION_DRIFT.md). Those never matched the
-- prod migration history and could not replay (branch build failed at 17).
--
-- ROLLOUT (not done here — needs explicit go-ahead):
--   * Fresh envs (branches/staging/DR): this baseline runs as the first migration.
--   * PROD: mark already-applied WITHOUT re-running, e.g.
--       supabase migration repair --status applied 20260627230000
--     (objects already exist on prod; this dump uses CREATE TABLE, not IF NOT EXISTS).
-- ============================================================================




SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "public";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."attribute_message_to_agent"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_role text;
  v_agent_id uuid;
BEGIN
  IF NEW.agent_id IS NOT NULL OR NEW.sender_type <> 'ai' THEN
    RETURN NEW;
  END IF;

  SELECT active_agent INTO v_role
    FROM conversations
   WHERE id = NEW.conversation_id;

  IF v_role IS NULL OR v_role NOT IN ('setter', 'closer') THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_agent_id
    FROM ai_agents
   WHERE organization_id = NEW.organization_id
     AND role = v_role
     AND is_active = true
   LIMIT 1;

  NEW.agent_id := v_agent_id;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."attribute_message_to_agent"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."auto_enable_rls_on_new_tables"() RETURNS "event_trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare obj record;
begin
  for obj in select * from pg_event_trigger_ddl_commands() where command_tag='CREATE TABLE' and object_type='table' loop
    if exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.oid=obj.objid and n.nspname='public' and c.relkind='r' and not c.relrowsecurity) then
      execute format('alter table %s enable row level security;', obj.object_identity);
    end if;
  end loop;
end;
$$;


ALTER FUNCTION "public"."auto_enable_rls_on_new_tables"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."count_ai_messages_last_hour"("p_conversation_id" "uuid") RETURNS integer
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$ SELECT COUNT(*)::INTEGER FROM messages WHERE conversation_id = p_conversation_id AND sender_type = 'ai' AND direction = 'outbound' AND created_at > NOW() - INTERVAL '1 hour'; $$;


ALTER FUNCTION "public"."count_ai_messages_last_hour"("p_conversation_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_contract_immutability"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if old.status = 'executed' then
    if new.executed_pdf_storage_path is distinct from old.executed_pdf_storage_path
       or new.executed_pdf_sha256 is distinct from old.executed_pdf_sha256
       or new.signature_data_url is distinct from old.signature_data_url
       or new.signed_at is distinct from old.signed_at
       or new.signer_name is distinct from old.signer_name
       or (new.status <> 'executed') then
      raise exception 'executed contracts are immutable';
    end if;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."enforce_contract_immutability"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_case_number"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  next_num integer;
BEGIN
  SELECT COALESCE(MAX(CAST(SUBSTRING(case_number FROM 'CASE-(\d+)') AS integer)), 0) + 1
  INTO next_num
  FROM public.clinical_cases
  WHERE organization_id = NEW.organization_id;

  NEW.case_number := 'CASE-' || LPAD(next_num::text, 5, '0');
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."generate_case_number"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_agent_kpi_summary"("p_org_id" "uuid", "p_start" timestamp with time zone DEFAULT ("now"() - '30 days'::interval), "p_end" timestamp with time zone DEFAULT "now"(), "p_agent_id" "uuid" DEFAULT NULL::"uuid") RETURNS json
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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
$$;


ALTER FUNCTION "public"."get_agent_kpi_summary"("p_org_id" "uuid", "p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_agent_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_lead_kpis"("p_org_id" "uuid") RETURNS json
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$ SELECT json_build_object('total_leads', count(*), 'hot_leads', count(*) FILTER (WHERE ai_qualification = 'hot'), 'warm_leads', count(*) FILTER (WHERE ai_qualification = 'warm'), 'cold_leads', count(*) FILTER (WHERE ai_qualification = 'cold'), 'qualified_leads', count(*) FILTER (WHERE status IN ('qualified', 'consultation_scheduled', 'consultation_completed', 'treatment_presented', 'financing', 'contract_sent', 'contract_signed')), 'converted_leads', count(*) FILTER (WHERE status IN ('contract_signed', 'scheduled', 'in_treatment', 'completed')), 'total_pipeline', coalesce(sum(treatment_value), 0), 'total_revenue', coalesce(sum(actual_revenue), 0), 'avg_score', coalesce(round(avg(ai_score)), 0), 'new_last_7d', count(*) FILTER (WHERE created_at >= now() - interval '7 days'), 'new_last_30d', count(*) FILTER (WHERE created_at >= now() - interval '30 days')) FROM leads WHERE organization_id = p_org_id; $$;


ALTER FUNCTION "public"."get_lead_kpis"("p_org_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_lead_kpis_ranged"("p_org_id" "uuid", "p_start" timestamp with time zone DEFAULT ("now"() - '30 days'::interval), "p_end" timestamp with time zone DEFAULT "now"()) RETURNS json
    LANGUAGE "plpgsql" STABLE
    AS $$ declare result json; begin select json_build_object('total_leads', count(*), 'hot_leads', count(*) filter (where ai_qualification = 'hot'), 'warm_leads', count(*) filter (where ai_qualification = 'warm'), 'cold_leads', count(*) filter (where ai_qualification = 'cold'), 'qualified_leads', count(*) filter (where status in ('qualified', 'consultation_scheduled', 'consultation_completed', 'treatment_presented', 'financing', 'contract_sent', 'contract_signed', 'scheduled', 'in_treatment', 'completed')), 'converted_leads', count(*) filter (where status in ('contract_signed', 'scheduled', 'in_treatment', 'completed')), 'total_pipeline', coalesce(sum(treatment_value) filter (where status not in ('lost', 'disqualified', 'completed')), 0), 'total_revenue', coalesce(sum(actual_revenue), 0), 'avg_score', coalesce(round(avg(ai_score) filter (where ai_score > 0)), 0), 'new_in_period', count(*) filter (where created_at between p_start and p_end)) from leads where organization_id = p_org_id into result; return result; end; $$;


ALTER FUNCTION "public"."get_lead_kpis_ranged"("p_org_id" "uuid", "p_start" timestamp with time zone, "p_end" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_lead_trend"("p_org_id" "uuid") RETURNS json
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$ WITH days AS (SELECT generate_series((current_date - interval '29 days')::date, current_date::date, '1 day'::interval)::date AS day), daily_leads AS (SELECT date_trunc('day', created_at)::date AS day, count(*) AS cnt FROM leads WHERE organization_id = p_org_id AND created_at >= now() - interval '30 days' GROUP BY 1), daily_conversions AS (SELECT date_trunc('day', converted_at)::date AS day, count(*) AS cnt FROM leads WHERE organization_id = p_org_id AND converted_at >= now() - interval '30 days' AND converted_at IS NOT NULL GROUP BY 1) SELECT json_agg(json_build_object('date', d.day, 'leads', coalesce(dl.cnt, 0), 'conversions', coalesce(dc.cnt, 0)) ORDER BY d.day) FROM days d LEFT JOIN daily_leads dl ON dl.day = d.day LEFT JOIN daily_conversions dc ON dc.day = d.day; $$;


ALTER FUNCTION "public"."get_lead_trend"("p_org_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_qualification_distribution"("p_org_id" "uuid") RETURNS json
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$ SELECT json_build_object('hot', count(*) FILTER (WHERE ai_qualification = 'hot'), 'warm', count(*) FILTER (WHERE ai_qualification = 'warm'), 'cold', count(*) FILTER (WHERE ai_qualification = 'cold'), 'unqualified', count(*) FILTER (WHERE ai_qualification = 'unqualified'), 'unscored', count(*) FILTER (WHERE ai_qualification = 'unscored' OR ai_qualification IS NULL)) FROM leads WHERE organization_id = p_org_id; $$;


ALTER FUNCTION "public"."get_qualification_distribution"("p_org_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_source_breakdown"("p_org_id" "uuid") RETURNS json
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$ SELECT coalesce(json_agg(json_build_object('source', source_type, 'count', cnt) ORDER BY cnt DESC), '[]'::json) FROM (SELECT coalesce(source_type, 'unknown') AS source_type, count(*) AS cnt FROM leads WHERE organization_id = p_org_id GROUP BY source_type) sub; $$;


ALTER FUNCTION "public"."get_source_breakdown"("p_org_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_source_roi"("p_org_id" "uuid", "p_start" timestamp with time zone DEFAULT ("now"() - '30 days'::interval), "p_end" timestamp with time zone DEFAULT "now"()) RETURNS json
    LANGUAGE "plpgsql" STABLE
    AS $$ declare result json; begin select coalesce(json_agg(row_to_json(t)), '[]'::json) from (select coalesce(source_type, 'unknown') as source, count(*) as lead_count, count(*) filter (where status in ('contract_signed', 'scheduled', 'in_treatment', 'completed')) as conversions, round(count(*) filter (where status in ('contract_signed', 'scheduled', 'in_treatment', 'completed')) * 100.0 / nullif(count(*), 0), 1) as conversion_rate, coalesce(sum(actual_revenue), 0) as total_revenue, coalesce(round(avg(actual_revenue) filter (where actual_revenue > 0)), 0) as avg_deal_size, coalesce(round(avg(ai_score)), 0) as avg_score from leads where organization_id = p_org_id and created_at between p_start and p_end group by source_type order by total_revenue desc, lead_count desc) t into result; return result; end; $$;


ALTER FUNCTION "public"."get_source_roi"("p_org_id" "uuid", "p_start" timestamp with time zone, "p_end" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_user_org_id"() RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select coalesce(
    (
      select a.active_org_id
      from public.agency_active_org a
      join public.user_profiles p on p.id = a.user_id
      where a.user_id = auth.uid()
        and p.role = 'agency_admin'
    ),
    (select organization_id from public.user_profiles where id = auth.uid())
  );
$$;


ALTER FUNCTION "public"."get_user_org_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_user_profile_privileged_columns"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  actor      uuid := auth.uid();
  actor_role text;
begin
  if actor is null then
    return new;
  end if;

  select role into actor_role
  from public.user_profiles
  where id = actor;

  if new.id is distinct from old.id then
    raise exception 'user_profiles.id is immutable';
  end if;

  if actor = old.id then
    if new.role is distinct from old.role then
      raise exception 'You cannot change your own role';
    end if;
    if new.organization_id is distinct from old.organization_id then
      raise exception 'You cannot change your own organization';
    end if;
  end if;

  if new.organization_id is distinct from old.organization_id then
    raise exception 'Re-assigning a user to a different organization is not permitted';
  end if;

  if new.role is distinct from old.role
     and new.role in ('agency_admin', 'owner')
     and coalesce(actor_role, '') <> 'agency_admin' then
    raise exception 'Insufficient privilege to assign role %', new.role;
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."guard_user_profile_privileged_columns"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_auth_user_created"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_org_id uuid;
  v_slug text;
  v_practice_name text;
  v_full_name text;
begin
  -- Get metadata passed during signUp
  v_full_name := coalesce(new.raw_user_meta_data->>'full_name', 'User');
  v_practice_name := coalesce(new.raw_user_meta_data->>'practice_name', 'My Practice');

  -- Generate slug
  v_slug := lower(regexp_replace(v_practice_name, '[^a-zA-Z0-9]+', '-', 'g'));
  v_slug := trim(both '-' from v_slug);
  v_slug := v_slug || '-' || substr(md5(random()::text), 1, 6);

  -- Create organization
  insert into public.organizations (name, slug, email)
  values (v_practice_name, v_slug, new.email)
  returning id into v_org_id;

  -- Create user profile (the FK to auth.users will succeed because this trigger
  -- fires AFTER the row exists in auth.users)
  insert into public.user_profiles (id, organization_id, full_name, email, role)
  values (new.id, v_org_id, v_full_name, new.email, 'owner');

  return new;
end;
$$;


ALTER FUNCTION "public"."handle_auth_user_created"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."handle_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."increment_asset_usage"("asset_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  UPDATE practice_content_assets SET usage_count = usage_count + 1 WHERE id = asset_id;
END;
$$;


ALTER FUNCTION "public"."increment_asset_usage"("asset_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."insert_qualified_lead"("p_org_id" "uuid", "p_first_name" "text", "p_last_name" "text" DEFAULT NULL::"text", "p_phone" "text" DEFAULT NULL::"text", "p_phone_formatted" "text" DEFAULT NULL::"text", "p_email" "text" DEFAULT NULL::"text", "p_city" "text" DEFAULT NULL::"text", "p_state" "text" DEFAULT NULL::"text", "p_dental_condition" "text" DEFAULT NULL::"text", "p_dental_condition_details" "text" DEFAULT NULL::"text", "p_has_dentures" boolean DEFAULT NULL::boolean, "p_urgency" "text" DEFAULT NULL::"text", "p_financing_interest" "text" DEFAULT NULL::"text", "p_has_dental_insurance" boolean DEFAULT false, "p_budget_range" "text" DEFAULT NULL::"text", "p_source_type" "text" DEFAULT 'landing_page'::"text", "p_utm_source" "text" DEFAULT NULL::"text", "p_utm_medium" "text" DEFAULT NULL::"text", "p_utm_campaign" "text" DEFAULT NULL::"text", "p_utm_content" "text" DEFAULT NULL::"text", "p_utm_term" "text" DEFAULT NULL::"text", "p_gclid" "text" DEFAULT NULL::"text", "p_fbclid" "text" DEFAULT NULL::"text", "p_landing_page_url" "text" DEFAULT NULL::"text", "p_custom_fields" "jsonb" DEFAULT '{}'::"jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_lead_id uuid;
  v_stage_id uuid;
  v_existing_id uuid;
begin
  -- Check for duplicate by phone or email
  if p_phone_formatted is not null or p_email is not null then
    select id into v_existing_id from public.leads
    where organization_id = p_org_id
      and (
        (p_phone_formatted is not null and phone_formatted = p_phone_formatted)
        or (p_email is not null and email = p_email)
      )
    limit 1;

    if v_existing_id is not null then
      -- Update existing lead
      update public.leads set
        dental_condition = coalesce(p_dental_condition, dental_condition),
        dental_condition_details = coalesce(p_dental_condition_details, dental_condition_details),
        has_dentures = coalesce(p_has_dentures, has_dentures),
        financing_interest = coalesce(p_financing_interest, financing_interest),
        has_dental_insurance = coalesce(p_has_dental_insurance, has_dental_insurance),
        budget_range = coalesce(p_budget_range, budget_range),
        custom_fields = p_custom_fields,
        updated_at = now()
      where id = v_existing_id;

      return jsonb_build_object('lead_id', v_existing_id, 'action', 'updated');
    end if;
  end if;

  -- Get default stage
  select id into v_stage_id from public.pipeline_stages
  where organization_id = p_org_id and is_default = true limit 1;

  -- Insert new lead
  insert into public.leads (
    organization_id, first_name, last_name, phone, phone_formatted, email,
    city, state, dental_condition, dental_condition_details, has_dentures,
    financing_interest, has_dental_insurance, budget_range,
    source_type, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    gclid, fbclid, landing_page_url, custom_fields, stage_id, status
  ) values (
    p_org_id, p_first_name, p_last_name, p_phone, p_phone_formatted, p_email,
    p_city, p_state, p_dental_condition, p_dental_condition_details, p_has_dentures,
    p_financing_interest, p_has_dental_insurance, p_budget_range,
    p_source_type, p_utm_source, p_utm_medium, p_utm_campaign, p_utm_content, p_utm_term,
    p_gclid, p_fbclid, p_landing_page_url, p_custom_fields, v_stage_id, 'new'
  )
  returning id into v_lead_id;

  -- Log activity
  insert into public.lead_activities (organization_id, lead_id, activity_type, title, metadata)
  values (p_org_id, v_lead_id, 'created', 'Lead qualified via intake form',
    jsonb_build_object('source', p_source_type, 'urgency', p_urgency));

  return jsonb_build_object('lead_id', v_lead_id, 'action', 'created');
end;
$$;


ALTER FUNCTION "public"."insert_qualified_lead"("p_org_id" "uuid", "p_first_name" "text", "p_last_name" "text", "p_phone" "text", "p_phone_formatted" "text", "p_email" "text", "p_city" "text", "p_state" "text", "p_dental_condition" "text", "p_dental_condition_details" "text", "p_has_dentures" boolean, "p_urgency" "text", "p_financing_interest" "text", "p_has_dental_insurance" boolean, "p_budget_range" "text", "p_source_type" "text", "p_utm_source" "text", "p_utm_medium" "text", "p_utm_campaign" "text", "p_utm_content" "text", "p_utm_term" "text", "p_gclid" "text", "p_fbclid" "text", "p_landing_page_url" "text", "p_custom_fields" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_admin_role"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select exists (
    select 1 from public.user_profiles
    where id = auth.uid()
      and role in ('doctor_admin', 'office_manager', 'owner', 'admin', 'agency_admin')
  );
$$;


ALTER FUNCTION "public"."is_admin_role"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_agency_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = auth.uid() AND role = 'agency_admin'
  );
$$;


ALTER FUNCTION "public"."is_agency_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."log_consent_change"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  IF (tg_op = 'INSERT' AND new.sms_consent = true)
     OR (tg_op = 'UPDATE' AND coalesce(old.sms_consent, false) IS DISTINCT FROM new.sms_consent AND new.sms_consent = true) THEN
    INSERT INTO public.consent_log (organization_id, lead_id, channel, consent_given, granted_at, source, source_text)
    VALUES (new.organization_id, new.id, 'sms', true, coalesce(new.sms_consent_at, now()), new.sms_consent_source, null);
  END IF;
  IF (tg_op = 'UPDATE' AND coalesce(old.sms_opt_out, false) IS DISTINCT FROM new.sms_opt_out AND new.sms_opt_out = true) THEN
    INSERT INTO public.consent_log (organization_id, lead_id, channel, consent_given, revoked_at, source)
    VALUES (new.organization_id, new.id, 'sms', false, coalesce(new.sms_opt_out_at, now()), 'inbound_stop');
  END IF;
  IF (tg_op = 'INSERT' AND new.email_consent = true)
     OR (tg_op = 'UPDATE' AND coalesce(old.email_consent, false) IS DISTINCT FROM new.email_consent AND new.email_consent = true) THEN
    INSERT INTO public.consent_log (organization_id, lead_id, channel, consent_given, granted_at, source)
    VALUES (new.organization_id, new.id, 'email', true, coalesce(new.email_consent_at, now()), new.email_consent_source);
  END IF;
  IF (tg_op = 'UPDATE' AND coalesce(old.email_opt_out, false) IS DISTINCT FROM new.email_opt_out AND new.email_opt_out = true) THEN
    INSERT INTO public.consent_log (organization_id, lead_id, channel, consent_given, revoked_at, source)
    VALUES (new.organization_id, new.id, 'email', false, coalesce(new.email_opt_out_at, now()), 'unsubscribe');
  END IF;
  IF (tg_op = 'INSERT' AND new.voice_consent = true)
     OR (tg_op = 'UPDATE' AND coalesce(old.voice_consent, false) IS DISTINCT FROM new.voice_consent AND new.voice_consent = true) THEN
    INSERT INTO public.consent_log (organization_id, lead_id, channel, consent_given, granted_at, source)
    VALUES (new.organization_id, new.id, 'voice', true, coalesce(new.voice_consent_at, now()), new.voice_consent_source);
  END IF;
  IF (tg_op = 'UPDATE'
      AND (coalesce(old.voice_opt_out, false) IS DISTINCT FROM new.voice_opt_out AND new.voice_opt_out = true
           OR coalesce(old.do_not_call, false) IS DISTINCT FROM new.do_not_call AND new.do_not_call = true)) THEN
    INSERT INTO public.consent_log (organization_id, lead_id, channel, consent_given, revoked_at, source)
    VALUES (new.organization_id, new.id, 'voice', false, coalesce(new.voice_opt_out_at, now()),
            CASE WHEN new.do_not_call = true THEN 'do_not_call' ELSE 'inbound_stop' END);
  END IF;
  RETURN new;
END;
$$;


ALTER FUNCTION "public"."log_consent_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_growth_studio_lead_event"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'net'
    AS $$
declare
  cfg        record;
  canonical  text;
  dgs_id     text;
  body       jsonb;
  req_id     bigint;
  val_cents  bigint;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  canonical := case new.status
    when 'contacted'               then 'contacted'
    when 'qualified'               then 'qualified'
    when 'consultation_scheduled'  then 'consult_booked'
    when 'scheduled'               then 'consult_booked'
    when 'consultation_completed'  then 'showed'
    when 'treatment_presented'     then 'showed'
    when 'financing'               then 'showed'
    when 'contract_sent'           then 'treatment_accepted'
    when 'contract_signed'         then 'treatment_accepted'
    when 'in_treatment'            then 'won'
    when 'completed'               then 'won'
    when 'lost'                    then 'lost'
    when 'disqualified'            then 'lost'
    when 'no_show'                 then null
    when 'unresponsive'            then null
    else null
  end;

  if canonical is null then
    if new.status not in ('no_show', 'unresponsive', 'new') then
      raise log 'notify_growth_studio_lead_event: unmapped lead status %, lead %', new.status, new.id;
    end if;
    return new;
  end if;

  dgs_id := coalesce(
    new.external_ref,
    substring(new.notes from 'dgs_lead_id:\s*([0-9a-fA-F-]{36})')
  );
  if dgs_id is null then
    return new;
  end if;

  select * into cfg from public.growth_studio_webhook_config where id = true and enabled;
  if not found then
    return new;
  end if;

  val_cents := case
                 when canonical in ('treatment_accepted', 'won') and new.treatment_value is not null
                 then round(new.treatment_value * 100)::bigint
                 else null
               end;

  body := jsonb_build_object(
    'customer_id', new.organization_id,
    'stage',       canonical,
    'lead_id',     dgs_id,
    'value_cents', val_cents,
    'li_lead_id',  new.id,
    'occurred_at', now()
  );

  req_id := net.http_post(
    url     := cfg.url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.bearer),
    body    := body
  );

  insert into public.growth_studio_outbox
    (organization_id, lead_id, external_ref, stage, value_cents, request_id, status, attempts)
  values
    (new.organization_id, new.id, dgs_id, canonical, val_cents, req_id, 'pending', 1);

  return new;
end;
$$;


ALTER FUNCTION "public"."notify_growth_studio_lead_event"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prevent_row_mutation"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  raise exception 'Table %.% is append-only — % is not permitted',
    tg_table_schema, tg_table_name, tg_op
    using errcode = 'check_violation';
end;
$$;


ALTER FUNCTION "public"."prevent_row_mutation"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reconcile_growth_studio_outbox"("max_retries" integer DEFAULT 5) RETURNS TABLE("outbox_id" "uuid", "new_status" "text", "status_code" integer, "error_msg" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'net'
    AS $$
declare
  rec        record;
  resp       record;
  cfg        record;
  body       jsonb;
  new_req_id bigint;
  prune_grace interval := interval '1 hour';
begin
  select * into cfg from public.growth_studio_webhook_config where id = true;

  for rec in
    select * from public.growth_studio_outbox
    where status = 'pending' and request_id is not null
    order by created_at asc
    limit 200
  loop
    select r.status_code, r.error_msg
      into resp
      from net._http_response r
      where r.id = rec.request_id
      limit 1;

    if found then
      if resp.status_code is not null and resp.status_code >= 200 and resp.status_code < 300 then
        update public.growth_studio_outbox
          set status = 'delivered', delivered_at = now(), last_error = null
          where id = rec.id;
        outbox_id := rec.id; new_status := 'delivered';
        status_code := resp.status_code; error_msg := null;
        return next;
      else
        if (rec.attempts + 1) >= max_retries or cfg is null or cfg.url is null then
          update public.growth_studio_outbox
            set status = 'failed', attempts = rec.attempts + 1,
                last_error = coalesce(resp.error_msg, 'http ' || coalesce(resp.status_code::text, 'error'))
            where id = rec.id;
          outbox_id := rec.id; new_status := 'failed';
          status_code := resp.status_code; error_msg := resp.error_msg;
          return next;
        else
          body := jsonb_build_object(
            'customer_id', rec.organization_id,
            'stage',       rec.stage,
            'lead_id',     rec.external_ref,
            'value_cents', rec.value_cents,
            'li_lead_id',  rec.lead_id,
            'occurred_at', now()
          );
          new_req_id := net.http_post(
            url     := cfg.url,
            headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.bearer),
            body    := body
          );
          update public.growth_studio_outbox
            set attempts = rec.attempts + 1, request_id = new_req_id, status = 'pending',
                last_error = coalesce(resp.error_msg, 'http ' || coalesce(resp.status_code::text, 'error'))
            where id = rec.id;
          outbox_id := rec.id; new_status := 'pending';
          status_code := resp.status_code; error_msg := resp.error_msg;
          return next;
        end if;
      end if;
    else
      if now() - rec.created_at > prune_grace then
        update public.growth_studio_outbox
          set status = 'unknown', last_error = 'net response pruned before reconcile'
          where id = rec.id;
        outbox_id := rec.id; new_status := 'unknown';
        status_code := null; error_msg := 'net response pruned before reconcile';
        return next;
      end if;
    end if;
  end loop;

  return;
end;
$$;


ALTER FUNCTION "public"."reconcile_growth_studio_outbox"("max_retries" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."refresh_agent_performance_daily"("p_org_id" "uuid", "p_date" "date" DEFAULT (CURRENT_DATE - 1)) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  agent_rec RECORD;
  day_start timestamptz := p_date::timestamptz;
  day_end timestamptz := (p_date + 1)::timestamptz;
  rows_written integer := 0;
  v_outbound int; v_inbound int; v_first_touched int;
  v_booked int; v_completed int; v_no_show int; v_resched int; v_canceled int;
  v_qualified int; v_disqualified int;
  v_ratings_count int; v_ratings_sum numeric;
  v_resp_count int; v_resp_total bigint;
  v_ai_cost bigint; v_revenue bigint;
BEGIN
  FOR agent_rec IN
    SELECT id, role FROM ai_agents
     WHERE organization_id = p_org_id AND is_active = true
  LOOP
    SELECT
      COUNT(*) FILTER (WHERE m.direction = 'outbound' AND m.sender_type = 'ai' AND m.agent_id = agent_rec.id),
      COUNT(*) FILTER (WHERE m.direction = 'inbound' AND c.active_agent = agent_rec.role)
    INTO v_outbound, v_inbound
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.organization_id = p_org_id
      AND m.created_at >= day_start AND m.created_at < day_end;

    SELECT COUNT(DISTINCT m.lead_id) INTO v_first_touched
    FROM messages m
    WHERE m.agent_id = agent_rec.id
      AND m.direction = 'outbound'
      AND m.sender_type = 'ai'
      AND m.created_at >= day_start AND m.created_at < day_end
      AND NOT EXISTS (
        SELECT 1 FROM messages m2
         WHERE m2.lead_id = m.lead_id
           AND m2.agent_id = agent_rec.id
           AND m2.created_at < day_start
      );

    SELECT COUNT(*) INTO v_booked
    FROM appointments a
    WHERE a.organization_id = p_org_id
      AND a.created_at >= day_start AND a.created_at < day_end
      AND EXISTS (
        SELECT 1 FROM messages m
         WHERE m.lead_id = a.lead_id
           AND m.agent_id = agent_rec.id
           AND m.created_at <= a.created_at
      );

    SELECT
      COUNT(*) FILTER (WHERE a.status = 'completed' AND a.completed_at >= day_start AND a.completed_at < day_end),
      COUNT(*) FILTER (WHERE a.status = 'no_show' AND COALESCE(a.no_show_at, a.scheduled_at) >= day_start AND COALESCE(a.no_show_at, a.scheduled_at) < day_end),
      COUNT(*) FILTER (WHERE a.status = 'rescheduled' AND a.updated_at >= day_start AND a.updated_at < day_end),
      COUNT(*) FILTER (WHERE a.status = 'canceled' AND COALESCE(a.canceled_at, a.updated_at) >= day_start AND COALESCE(a.canceled_at, a.updated_at) < day_end)
    INTO v_completed, v_no_show, v_resched, v_canceled
    FROM appointments a
    WHERE a.organization_id = p_org_id
      AND EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = a.lead_id AND m.agent_id = agent_rec.id);

    SELECT
      COUNT(*) FILTER (WHERE la.activity_type = 'qualified'),
      COUNT(*) FILTER (WHERE la.activity_type = 'disqualified')
    INTO v_qualified, v_disqualified
    FROM lead_activities la
    WHERE la.organization_id = p_org_id
      AND la.created_at >= day_start AND la.created_at < day_end
      AND EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = la.lead_id AND m.agent_id = agent_rec.id);

    SELECT
      COUNT(*),
      COALESCE(SUM(r.rating), 0)::numeric
    INTO v_ratings_count, v_ratings_sum
    FROM ai_conversation_ratings r
    JOIN conversations c ON c.id = r.conversation_id
    WHERE r.organization_id = p_org_id
      AND c.active_agent = agent_rec.role
      AND r.created_at >= day_start AND r.created_at < day_end;

    WITH pairs AS (
      SELECT
        reply.created_at AS reply_at,
        (SELECT MAX(inb.created_at)
           FROM messages inb
          WHERE inb.conversation_id = reply.conversation_id
            AND inb.direction = 'inbound'
            AND inb.created_at < reply.created_at) AS inbound_at
      FROM messages reply
      WHERE reply.agent_id = agent_rec.id
        AND reply.direction = 'outbound'
        AND reply.created_at >= day_start AND reply.created_at < day_end
    )
    SELECT
      COUNT(*) FILTER (WHERE inbound_at IS NOT NULL),
      COALESCE(SUM(EXTRACT(EPOCH FROM (reply_at - inbound_at))) FILTER (WHERE inbound_at IS NOT NULL), 0)::bigint
    INTO v_resp_count, v_resp_total
    FROM pairs;

    SELECT COALESCE(ROUND(SUM(COALESCE((ai.metadata->>'cost_usd')::numeric, 0)) * 100)::bigint, 0)
    INTO v_ai_cost
    FROM ai_interactions ai
    WHERE ai.organization_id = p_org_id
      AND ai.metadata->>'agent' = agent_rec.role
      AND ai.created_at >= day_start AND ai.created_at < day_end;

    SELECT COALESCE(ROUND(SUM(amount) * 100)::bigint, 0) INTO v_revenue
    FROM (
      SELECT i.amount
        FROM invoices i
        JOIN patients p ON p.id = i.patient_id
       WHERE i.organization_id = p_org_id
         AND i.payment_date >= day_start AND i.payment_date < day_end
         AND p.lead_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = p.lead_id AND m.agent_id = agent_rec.id)
      UNION ALL
      SELECT sp.amount
        FROM stripe_payments sp
       WHERE sp.organization_id = p_org_id
         AND sp.occurred_at >= day_start AND sp.occurred_at < day_end
         AND sp.lead_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = sp.lead_id AND m.agent_id = agent_rec.id)
    ) t;

    INSERT INTO agent_performance_daily (
      agent_id, organization_id, date,
      outbound_ai_messages, inbound_messages, leads_first_touched,
      appts_booked, appts_completed, appts_no_show, appts_rescheduled, appts_canceled,
      leads_qualified, leads_disqualified,
      conversation_ratings_count, conversation_ratings_sum,
      response_count, response_total_seconds,
      ai_cost_cents, closed_revenue_cents, refreshed_at
    ) VALUES (
      agent_rec.id, p_org_id, p_date,
      v_outbound, v_inbound, v_first_touched,
      v_booked, v_completed, v_no_show, v_resched, v_canceled,
      v_qualified, v_disqualified,
      v_ratings_count, v_ratings_sum,
      v_resp_count, v_resp_total,
      v_ai_cost, v_revenue, now()
    )
    ON CONFLICT (agent_id, date) DO UPDATE SET
      outbound_ai_messages       = EXCLUDED.outbound_ai_messages,
      inbound_messages           = EXCLUDED.inbound_messages,
      leads_first_touched        = EXCLUDED.leads_first_touched,
      appts_booked               = EXCLUDED.appts_booked,
      appts_completed            = EXCLUDED.appts_completed,
      appts_no_show              = EXCLUDED.appts_no_show,
      appts_rescheduled          = EXCLUDED.appts_rescheduled,
      appts_canceled             = EXCLUDED.appts_canceled,
      leads_qualified            = EXCLUDED.leads_qualified,
      leads_disqualified         = EXCLUDED.leads_disqualified,
      conversation_ratings_count = EXCLUDED.conversation_ratings_count,
      conversation_ratings_sum   = EXCLUDED.conversation_ratings_sum,
      response_count             = EXCLUDED.response_count,
      response_total_seconds     = EXCLUDED.response_total_seconds,
      ai_cost_cents              = EXCLUDED.ai_cost_cents,
      closed_revenue_cents       = EXCLUDED.closed_revenue_cents,
      refreshed_at               = now();

    rows_written := rows_written + 1;
  END LOOP;

  RETURN rows_written;
END;
$$;


ALTER FUNCTION "public"."refresh_agent_performance_daily"("p_org_id" "uuid", "p_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resolve_lead_source_id"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  resolved uuid;
BEGIN
  IF NEW.source_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- 1) Exact UTM match (most specific)
  IF NEW.utm_source IS NOT NULL AND NEW.utm_medium IS NOT NULL THEN
    SELECT id INTO resolved FROM lead_sources
      WHERE organization_id = NEW.organization_id AND is_active = true
        AND lower(utm_source) = lower(NEW.utm_source)
        AND lower(utm_medium) = lower(NEW.utm_medium)
      LIMIT 1;
  END IF;

  -- 2) source_type matches the lead_sources.type enum
  IF resolved IS NULL AND NEW.source_type IS NOT NULL THEN
    SELECT id INTO resolved FROM lead_sources
      WHERE organization_id = NEW.organization_id AND is_active = true
        AND lower(type) = lower(NEW.source_type)
      LIMIT 1;
  END IF;

  -- 3) source_type matches a per-org override in metadata.source_type_match
  IF resolved IS NULL AND NEW.source_type IS NOT NULL THEN
    SELECT id INTO resolved FROM lead_sources
      WHERE organization_id = NEW.organization_id AND is_active = true
        AND lower(metadata->>'source_type_match') = lower(NEW.source_type)
      LIMIT 1;
  END IF;

  -- 4) Fallback: 'Unknown' bucket
  IF resolved IS NULL THEN
    SELECT id INTO resolved FROM lead_sources
      WHERE organization_id = NEW.organization_id AND name = 'Unknown' AND is_active = true
      LIMIT 1;
  END IF;

  NEW.source_id := resolved;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."resolve_lead_source_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."seed_agent_lead_caps"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  INSERT INTO agent_lead_caps (agent_id, organization_id, base_daily_cap, multiplier)
  VALUES (NEW.id, NEW.organization_id, 100, 1.00)
  ON CONFLICT (agent_id) DO NOTHING;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."seed_agent_lead_caps"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."seed_agent_status_current"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  INSERT INTO agent_status_current (agent_id, organization_id, status)
  VALUES (NEW.id, NEW.organization_id, 'unrated')
  ON CONFLICT (agent_id) DO NOTHING;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."seed_agent_status_current"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."seed_default_agents_for_org"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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
    (closer_id, new.id, 'treatment_success_rate', 85, 75, 60, 'higher_is_better');

  return new;
end;
$$;


ALTER FUNCTION "public"."seed_default_agents_for_org"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."seed_default_pipeline_stages"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  insert into public.pipeline_stages (organization_id, name, slug, color, position, is_default) values
    (new.id, 'New Lead', 'new', '#3B82F6', 0, true),
    (new.id, 'Contacted', 'contacted', '#8B5CF6', 1, false),
    (new.id, 'Qualified', 'qualified', '#F59E0B', 2, false),
    (new.id, 'Consultation Scheduled', 'consultation-scheduled', '#10B981', 3, false),
    (new.id, 'Consultation Completed', 'consultation-completed', '#06B6D4', 4, false),
    (new.id, 'Treatment Presented', 'treatment-presented', '#EC4899', 5, false),
    (new.id, 'Financing', 'financing', '#F97316', 6, false),
    (new.id, 'Contract Signed', 'contract-signed', '#14B8A6', 7, false),
    (new.id, 'Scheduled for Treatment', 'scheduled', '#6366F1', 8, false);
  insert into public.pipeline_stages (organization_id, name, slug, color, position, is_won) values
    (new.id, 'Completed', 'completed', '#22C55E', 9, true);
  insert into public.pipeline_stages (organization_id, name, slug, color, position, is_lost) values
    (new.id, 'Lost', 'lost', '#EF4444', 10, true);
  return new;
end;
$$;


ALTER FUNCTION "public"."seed_default_pipeline_stages"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."seed_reactivation_campaign"("p_org_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_campaign_id uuid;
begin
  select id into v_campaign_id from public.campaigns
  where organization_id = p_org_id and name = 'Reactivation' limit 1;
  if v_campaign_id is not null then return v_campaign_id; end if;

  insert into public.campaigns (organization_id, name, description, type, channel, status, target_criteria, metadata)
  values (p_org_id, 'Reactivation',
    'Default 14-day reactivation sequence for dormant leads (no activity > 60 days).',
    'trigger', 'multi', 'active',
    '{"status": ["dormant"]}'::jsonb,
    '{"seeded_by": "migration_024", "auto_managed": true}'::jsonb)
  returning id into v_campaign_id;

  insert into public.campaign_steps (campaign_id, organization_id, step_number, name, channel, delay_minutes, body_template, ai_personalize)
  values (v_campaign_id, p_org_id, 1, 'Day 0 - SMS check-in', 'sms', 0,
    'Hi {{first_name}}, it''s {{practice_name}}. We noticed it''s been a while since we last connected. Still interested in exploring your options? Reply YES and we''ll find a time that works.',
    false);

  insert into public.campaign_steps (campaign_id, organization_id, step_number, name, channel, delay_minutes, subject, body_template, ai_personalize, exit_condition)
  values (v_campaign_id, p_org_id, 2, 'Day 2 - Email follow-up', 'email', 2880,
    'Still thinking it over, {{first_name}}?',
    'Hi {{first_name}},' || E'\n\n' ||
    'No pressure at all - just wanted to follow up on the inquiry you sent us at {{practice_name}}.' || E'\n\n' ||
    'A lot of patients in your situation worry about cost or recovery time. Both are easier to plan around than you''d think - financing is straightforward and the consult itself is free.' || E'\n\n' ||
    'If now isn''t the right time, just reply and let me know. Otherwise, here''s a link to grab a slot whenever works for you.' || E'\n\n' ||
    '- The team at {{practice_name}}',
    false, '{"if_replied": true}'::jsonb);

  insert into public.campaign_steps (campaign_id, organization_id, step_number, name, channel, delay_minutes, body_template, ai_personalize, exit_condition)
  values (v_campaign_id, p_org_id, 3, 'Day 5 - SMS soft offer', 'sms', 4320,
    'Hey {{first_name}} - totally understand if now isn''t the right time. Want me to send you some info to look at when you''re ready instead? No commitment.',
    false, '{"if_replied": true}'::jsonb);

  insert into public.campaign_steps (campaign_id, organization_id, step_number, name, channel, delay_minutes, body_template, ai_personalize, exit_condition)
  values (v_campaign_id, p_org_id, 4, 'Day 10 - Reactivation voice check-in (Retell)', 'voice', 7200,
    'Hi {{first_name}}, this is the team at {{practice_name}}. We noticed it''s been a while - calling to see if you''re still interested. No pressure, just wanted to check in.',
    false, '{"if_replied": true}'::jsonb);
  return v_campaign_id;
end;
$$;


ALTER FUNCTION "public"."seed_reactivation_campaign"("p_org_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_consent_status"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF NEW.sms_opt_out IS TRUE THEN NEW.sms_consent_status := 'declined';
  ELSIF NEW.sms_consent IS TRUE THEN NEW.sms_consent_status := 'granted';
  ELSIF NEW.sms_consent_status IS NULL THEN NEW.sms_consent_status := 'unknown';
  END IF;
  IF NEW.email_opt_out IS TRUE THEN NEW.email_consent_status := 'declined';
  ELSIF NEW.email_consent IS TRUE THEN NEW.email_consent_status := 'granted';
  ELSIF NEW.email_consent_status IS NULL THEN NEW.email_consent_status := 'unknown';
  END IF;
  IF NEW.do_not_call IS TRUE OR NEW.voice_opt_out IS TRUE THEN NEW.voice_consent_status := 'declined';
  ELSIF NEW.voice_consent IS TRUE THEN NEW.voice_consent_status := 'granted';
  ELSIF NEW.voice_consent_status IS NULL THEN NEW.voice_consent_status := 'unknown';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."sync_consent_status"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_seed_reactivation_campaign"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin perform public.seed_reactivation_campaign(new.id); return new; end;
$$;


ALTER FUNCTION "public"."trigger_seed_reactivation_campaign"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_appointment_reminders_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;


ALTER FUNCTION "public"."update_appointment_reminders_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_content_assets_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_content_assets_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_conversation_on_message"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  update public.conversations set
    last_message_at = new.created_at,
    last_message_preview = left(new.body, 100),
    message_count = message_count + 1,
    unread_count = case when new.direction = 'inbound' then unread_count + 1 else unread_count end,
    updated_at = now()
  where id = new.conversation_id;
  if new.direction = 'outbound' then
    update public.leads set
      total_messages_sent = total_messages_sent + 1,
      last_contacted_at = new.created_at,
      total_sms_sent = case when new.channel = 'sms' then total_sms_sent + 1 else total_sms_sent end,
      total_emails_sent = case when new.channel = 'email' then total_emails_sent + 1 else total_emails_sent end
    where id = new.lead_id;
  else
    update public.leads set
      total_messages_received = total_messages_received + 1,
      last_responded_at = new.created_at,
      total_sms_received = case when new.channel = 'sms' then total_sms_received + 1 else total_sms_received end
    where id = new.lead_id;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."update_conversation_on_message"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_patient_profile_timestamp"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$ begin new.updated_at = now(); return new; end; $$;


ALTER FUNCTION "public"."update_patient_profile_timestamp"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_tag_lead_count"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$ BEGIN IF TG_OP = 'INSERT' THEN UPDATE public.tags SET lead_count = lead_count + 1 WHERE id = NEW.tag_id; RETURN NEW; ELSIF TG_OP = 'DELETE' THEN UPDATE public.tags SET lead_count = greatest(lead_count - 1, 0) WHERE id = OLD.tag_id; RETURN OLD; END IF; RETURN NULL; END; $$;


ALTER FUNCTION "public"."update_tag_lead_count"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_treatment_closings_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_treatment_closings_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_updated_at_column"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_voice_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_voice_updated_at"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."a2p_status" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "campaign_sid" "text" NOT NULL,
    "campaign_status" "text",
    "previous_campaign_status" "text",
    "brand_sid" "text",
    "brand_status" "text",
    "last_checked_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_transition_at" timestamp with time zone,
    "raw" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."a2p_status" OWNER TO "postgres";


COMMENT ON TABLE "public"."a2p_status" IS 'Latest Twilio A2P 10DLC brand+campaign status snapshot, one row per campaign SID.';



CREATE TABLE IF NOT EXISTS "public"."ad_metrics_daily" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "channel" "text" NOT NULL,
    "account_id" "text" NOT NULL,
    "campaign_id" "text",
    "campaign_name" "text",
    "metric_date" "date" NOT NULL,
    "impressions" bigint DEFAULT 0 NOT NULL,
    "clicks" bigint DEFAULT 0 NOT NULL,
    "spend" numeric(14,4) DEFAULT 0 NOT NULL,
    "conversions" numeric(14,4) DEFAULT 0 NOT NULL,
    "conversion_value" numeric(14,4) DEFAULT 0 NOT NULL,
    "sessions" bigint,
    "users" bigint,
    "engaged_sessions" bigint,
    "currency" "text",
    "synced_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ad_metrics_daily_channel_check" CHECK (("channel" = ANY (ARRAY['google_ads'::"text", 'meta'::"text", 'ga4'::"text"])))
);


ALTER TABLE "public"."ad_metrics_daily" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ad_metrics_sync_state" (
    "organization_id" "uuid" NOT NULL,
    "channel" "text" NOT NULL,
    "last_synced_at" timestamp with time zone,
    "last_success_at" timestamp with time zone,
    "last_error" "text",
    "rows_inserted_last_run" integer,
    CONSTRAINT "ad_metrics_sync_state_channel_check" CHECK (("channel" = ANY (ARRAY['google_ads'::"text", 'meta'::"text", 'ga4'::"text"])))
);


ALTER TABLE "public"."ad_metrics_sync_state" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ad_spend_daily" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "date" "date" NOT NULL,
    "platform" "text" NOT NULL,
    "account_id" "text",
    "account_name" "text",
    "campaign_id" "text",
    "campaign_name" "text",
    "ad_group_id" "text",
    "ad_group_name" "text",
    "spend" numeric(12,2) DEFAULT 0 NOT NULL,
    "impressions" integer DEFAULT 0 NOT NULL,
    "clicks" integer DEFAULT 0 NOT NULL,
    "conversions" numeric(12,2) DEFAULT 0,
    "conversion_value" numeric(12,2) DEFAULT 0,
    "cpc" numeric(10,4),
    "cpm" numeric(10,4),
    "ctr" numeric(6,4),
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "ad_spend_daily_platform_check" CHECK (("platform" = ANY (ARRAY['google_ads'::"text", 'meta_ads'::"text", 'tiktok_ads'::"text", 'youtube_ads'::"text", 'linkedin_ads'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."ad_spend_daily" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agency_active_org" (
    "user_id" "uuid" NOT NULL,
    "active_org_id" "uuid" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."agency_active_org" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agency_settings" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "key" "text" NOT NULL,
    "value" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "description" "text",
    "updated_by" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."agency_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agent_handoffs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "lead_id" "uuid" NOT NULL,
    "from_agent" "text" NOT NULL,
    "to_agent" "text" NOT NULL,
    "trigger_reason" "text" NOT NULL,
    "context_snapshot" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "initiated_by" "text" NOT NULL,
    "initiated_by_user_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "agent_handoffs_from_agent_check" CHECK (("from_agent" = ANY (ARRAY['setter'::"text", 'closer'::"text", 'none'::"text", 'manual'::"text"]))),
    CONSTRAINT "agent_handoffs_initiated_by_check" CHECK (("initiated_by" = ANY (ARRAY['system'::"text", 'user'::"text", 'ai'::"text"]))),
    CONSTRAINT "agent_handoffs_to_agent_check" CHECK (("to_agent" = ANY (ARRAY['setter'::"text", 'closer'::"text", 'none'::"text", 'manual'::"text"])))
);


ALTER TABLE "public"."agent_handoffs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agent_kpi_targets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "agent_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "kpi_name" "text" NOT NULL,
    "target_value" numeric NOT NULL,
    "warning_threshold" numeric NOT NULL,
    "critical_threshold" numeric NOT NULL,
    "direction" "text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "agent_kpi_targets_direction_check" CHECK (("direction" = ANY (ARRAY['higher_is_better'::"text", 'lower_is_better'::"text"])))
);


ALTER TABLE "public"."agent_kpi_targets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agent_lead_caps" (
    "agent_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "base_daily_cap" integer DEFAULT 100 NOT NULL,
    "multiplier" numeric(4,2) DEFAULT 1.00 NOT NULL,
    "autopilot_mode_override" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "agent_lead_caps_autopilot_mode_override_check" CHECK (("autopilot_mode_override" = ANY (ARRAY['auto'::"text", 'review_first'::"text", 'off'::"text"]))),
    CONSTRAINT "agent_lead_caps_multiplier_check" CHECK ((("multiplier" >= 0.10) AND ("multiplier" <= 3.00)))
);


ALTER TABLE "public"."agent_lead_caps" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agent_performance_daily" (
    "agent_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "date" "date" NOT NULL,
    "outbound_ai_messages" integer DEFAULT 0 NOT NULL,
    "inbound_messages" integer DEFAULT 0 NOT NULL,
    "leads_first_touched" integer DEFAULT 0 NOT NULL,
    "appts_booked" integer DEFAULT 0 NOT NULL,
    "appts_completed" integer DEFAULT 0 NOT NULL,
    "appts_no_show" integer DEFAULT 0 NOT NULL,
    "appts_rescheduled" integer DEFAULT 0 NOT NULL,
    "appts_canceled" integer DEFAULT 0 NOT NULL,
    "leads_qualified" integer DEFAULT 0 NOT NULL,
    "leads_disqualified" integer DEFAULT 0 NOT NULL,
    "conversation_ratings_count" integer DEFAULT 0 NOT NULL,
    "conversation_ratings_sum" numeric DEFAULT 0 NOT NULL,
    "response_count" integer DEFAULT 0 NOT NULL,
    "response_total_seconds" bigint DEFAULT 0 NOT NULL,
    "ai_cost_cents" bigint DEFAULT 0 NOT NULL,
    "closed_revenue_cents" bigint DEFAULT 0 NOT NULL,
    "refreshed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."agent_performance_daily" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agent_performance_reviews" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "agent_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "period_start" "date" NOT NULL,
    "period_end" "date" NOT NULL,
    "kpi_scores" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "overall_grade" "text" NOT NULL,
    "reasons" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "notes" "text",
    "reviewed_by" "uuid",
    "reviewed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "acknowledged_by" "uuid",
    "acknowledged_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "agent_performance_reviews_overall_grade_check" CHECK (("overall_grade" = ANY (ARRAY['green'::"text", 'yellow'::"text", 'red'::"text", 'probation'::"text"])))
);


ALTER TABLE "public"."agent_performance_reviews" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agent_protocol_changes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "agent_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "change_type" "text" NOT NULL,
    "triggered_by" "text" NOT NULL,
    "from_protocol_id" "uuid",
    "to_protocol_id" "uuid",
    "from_multiplier" numeric(4,2),
    "to_multiplier" numeric(4,2),
    "reason" "text" NOT NULL,
    "reference_review_id" "uuid",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "agent_protocol_changes_change_type_check" CHECK (("change_type" = ANY (ARRAY['protocol_swap'::"text", 'cap_increase'::"text", 'cap_decrease'::"text", 'autopilot_throttle'::"text", 'protocol_proposed'::"text"]))),
    CONSTRAINT "agent_protocol_changes_triggered_by_check" CHECK (("triggered_by" = ANY (ARRAY['auto_discipline'::"text", 'auto_reward'::"text", 'manual'::"text", 'ab_test'::"text", 'rollback'::"text"])))
);


ALTER TABLE "public"."agent_protocol_changes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agent_protocols" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "agent_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "version" integer NOT NULL,
    "name" "text" NOT NULL,
    "prompt_override" "text",
    "outreach_templates" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "cadence_config" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "channel_rules" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "is_active" boolean DEFAULT false NOT NULL,
    "created_from" "text" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    CONSTRAINT "agent_protocols_created_from_check" CHECK (("created_from" = ANY (ARRAY['seed'::"text", 'manual'::"text", 'auto_tune'::"text", 'ab_test'::"text", 'rollback'::"text"])))
);


ALTER TABLE "public"."agent_protocols" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agent_status_current" (
    "agent_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "status" "text" NOT NULL,
    "since" timestamp with time zone DEFAULT "now"() NOT NULL,
    "consecutive_red_periods" integer DEFAULT 0 NOT NULL,
    "consecutive_green_periods" integer DEFAULT 0 NOT NULL,
    "last_review_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "agent_status_current_status_check" CHECK (("status" = ANY (ARRAY['green'::"text", 'yellow'::"text", 'red'::"text", 'probation'::"text", 'unrated'::"text"])))
);


ALTER TABLE "public"."agent_status_current" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_agents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "role" "text" NOT NULL,
    "persona_description" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    CONSTRAINT "ai_agents_role_check" CHECK (("role" = ANY (ARRAY['setter'::"text", 'closer'::"text"])))
);


ALTER TABLE "public"."ai_agents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_conversation_ratings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "lead_id" "uuid" NOT NULL,
    "rated_by" "uuid" NOT NULL,
    "rating" integer NOT NULL,
    "notes" "text",
    "flagged" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "ai_conversation_ratings_rating_check" CHECK ((("rating" >= 1) AND ("rating" <= 5)))
);


ALTER TABLE "public"."ai_conversation_ratings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_interactions" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "lead_id" "uuid",
    "interaction_type" "text" NOT NULL,
    "model" "text" NOT NULL,
    "prompt_tokens" integer,
    "completion_tokens" integer,
    "total_tokens" integer,
    "cost_usd" numeric(10,6),
    "latency_ms" integer,
    "input_summary" "text",
    "output_summary" "text",
    "success" boolean DEFAULT true,
    "error" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "ai_interactions_interaction_type_check" CHECK (("interaction_type" = ANY (ARRAY['scoring'::"text", 'engagement'::"text", 'education'::"text", 'objection_handling'::"text", 'summary'::"text", 'classification'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."ai_interactions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_knowledge_articles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "created_by" "uuid",
    "title" "text" NOT NULL,
    "category" "text" NOT NULL,
    "content" "text" NOT NULL,
    "tags" "text"[] DEFAULT '{}'::"text"[],
    "is_enabled" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "ai_knowledge_articles_category_check" CHECK (("category" = ANY (ARRAY['procedures'::"text", 'pricing'::"text", 'faqs'::"text", 'aftercare'::"text", 'financing'::"text", 'general'::"text"])))
);


ALTER TABLE "public"."ai_knowledge_articles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_memories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "created_by" "uuid",
    "title" "text" NOT NULL,
    "category" "text" NOT NULL,
    "content" "text" NOT NULL,
    "is_enabled" boolean DEFAULT true,
    "priority" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "ai_memories_category_check" CHECK (("category" = ANY (ARRAY['tone_and_style'::"text", 'product_knowledge'::"text", 'objection_handling'::"text", 'pricing_rules'::"text", 'compliance_rules'::"text", 'general'::"text"])))
);


ALTER TABLE "public"."ai_memories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_roleplay_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "created_by" "uuid",
    "title" "text" DEFAULT 'Untitled Session'::"text" NOT NULL,
    "user_role" "text" NOT NULL,
    "agent_target" "text" NOT NULL,
    "scenario_id" "text",
    "scenario_description" "text",
    "patient_persona" "jsonb",
    "messages" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "session_summary" "text",
    "extracted_example_count" integer DEFAULT 0 NOT NULL,
    "overall_rating" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ai_roleplay_sessions_agent_target_check" CHECK (("agent_target" = ANY (ARRAY['setter'::"text", 'closer'::"text"]))),
    CONSTRAINT "ai_roleplay_sessions_overall_rating_check" CHECK ((("overall_rating" >= 1) AND ("overall_rating" <= 5))),
    CONSTRAINT "ai_roleplay_sessions_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'completed'::"text", 'archived'::"text"]))),
    CONSTRAINT "ai_roleplay_sessions_user_role_check" CHECK (("user_role" = ANY (ARRAY['patient'::"text", 'treatment_coordinator'::"text"])))
);


ALTER TABLE "public"."ai_roleplay_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_test_conversations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "created_by" "uuid",
    "title" "text" DEFAULT 'Untitled Conversation'::"text" NOT NULL,
    "mode" "text" DEFAULT 'general'::"text" NOT NULL,
    "messages" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "system_prompt_snapshot" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."ai_test_conversations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_training_examples" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "session_id" "uuid" NOT NULL,
    "category" "text" DEFAULT 'general'::"text" NOT NULL,
    "scenario_context" "text" NOT NULL,
    "patient_message" "text" NOT NULL,
    "ideal_response" "text" NOT NULL,
    "coaching_notes" "text",
    "agent_target" "text" NOT NULL,
    "is_approved" boolean DEFAULT false NOT NULL,
    "is_active" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ai_training_examples_agent_target_check" CHECK (("agent_target" = ANY (ARRAY['setter'::"text", 'closer'::"text"]))),
    CONSTRAINT "ai_training_examples_category_check" CHECK (("category" = ANY (ARRAY['ideal_response'::"text", 'objection_handling'::"text", 'rapport_building'::"text", 'closing_technique'::"text", 'patient_education'::"text", 'follow_up'::"text", 'general'::"text"])))
);


ALTER TABLE "public"."ai_training_examples" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_usage" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "lead_id" "uuid",
    "feature" "text" NOT NULL,
    "model" "text" NOT NULL,
    "tokens_in" integer DEFAULT 0 NOT NULL,
    "tokens_out" integer DEFAULT 0 NOT NULL,
    "cost_cents" numeric(10,4) DEFAULT 0,
    "duration_ms" integer,
    "succeeded" boolean DEFAULT true NOT NULL,
    "error_message" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "occurred_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ai_usage" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."appointment_reminders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "appointment_id" "uuid" NOT NULL,
    "lead_id" "uuid" NOT NULL,
    "channel" "text" NOT NULL,
    "reminder_type" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "confirmation_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "scheduled_for" timestamp with time zone,
    "sent_at" timestamp with time zone,
    "response_at" timestamp with time zone,
    "response_text" "text",
    "external_id" "text",
    "voice_call_id" "uuid",
    "error_message" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "appointment_reminders_channel_check" CHECK (("channel" = ANY (ARRAY['sms'::"text", 'email'::"text", 'voice_confirmation'::"text"]))),
    CONSTRAINT "appointment_reminders_confirmation_status_check" CHECK (("confirmation_status" = ANY (ARRAY['pending'::"text", 'confirmed'::"text", 'declined'::"text", 'rescheduled'::"text", 'no_response'::"text"]))),
    CONSTRAINT "appointment_reminders_reminder_type_check" CHECK (("reminder_type" = ANY (ARRAY['72h'::"text", '24h'::"text", '2h'::"text", '1h'::"text", 'confirmation_call'::"text", 'manual'::"text"]))),
    CONSTRAINT "appointment_reminders_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'sent'::"text", 'delivered'::"text", 'failed'::"text", 'skipped'::"text"])))
);


ALTER TABLE "public"."appointment_reminders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."appointments" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "lead_id" "uuid" NOT NULL,
    "assigned_to" "uuid",
    "type" "text" NOT NULL,
    "status" "text" DEFAULT 'scheduled'::"text",
    "scheduled_at" timestamp with time zone NOT NULL,
    "duration_minutes" integer DEFAULT 60,
    "location" "text",
    "notes" "text",
    "reminder_sent_24h" boolean DEFAULT false,
    "reminder_sent_1h" boolean DEFAULT false,
    "confirmation_received" boolean DEFAULT false,
    "completed_at" timestamp with time zone,
    "no_show_at" timestamp with time zone,
    "canceled_at" timestamp with time zone,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "reminder_sent_72h" boolean DEFAULT false,
    "reminder_sent_2h" boolean DEFAULT false,
    "confirmation_call_made" boolean DEFAULT false,
    "confirmed_via" "text",
    "confirmed_at" timestamp with time zone,
    "reschedule_requested" boolean DEFAULT false,
    "no_show_risk_score" integer DEFAULT 0,
    "external_id" "text",
    "external_source" "text" DEFAULT 'manual'::"text",
    "patient_id" "uuid",
    CONSTRAINT "appointments_external_source_check" CHECK (("external_source" = ANY (ARRAY['manual'::"text", 'cal_com'::"text", 'carestack'::"text"]))),
    CONSTRAINT "appointments_status_check" CHECK (("status" = ANY (ARRAY['scheduled'::"text", 'confirmed'::"text", 'completed'::"text", 'no_show'::"text", 'canceled'::"text", 'rescheduled'::"text"]))),
    CONSTRAINT "appointments_type_check" CHECK (("type" = ANY (ARRAY['consultation'::"text", 'follow_up'::"text", 'treatment'::"text", 'scan'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."appointments" OWNER TO "postgres";


COMMENT ON COLUMN "public"."appointments"."confirmed_via" IS 'How the lead confirmed: sms_reply, email_click, voice_call, manual';



COMMENT ON COLUMN "public"."appointments"."no_show_risk_score" IS 'AI-calculated risk score 0-100 based on engagement patterns';



CREATE TABLE IF NOT EXISTS "public"."booking_settings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "is_enabled" boolean DEFAULT true,
    "slot_duration_minutes" integer DEFAULT 60,
    "buffer_minutes" integer DEFAULT 15,
    "advance_days" integer DEFAULT 14,
    "min_notice_hours" integer DEFAULT 24,
    "weekly_schedule" "jsonb" DEFAULT '{"1": {"end": "17:00", "start": "09:00"}, "2": {"end": "17:00", "start": "09:00"}, "3": {"end": "17:00", "start": "09:00"}, "4": {"end": "17:00", "start": "09:00"}, "5": {"end": "17:00", "start": "09:00"}}'::"jsonb",
    "blocked_dates" "text"[] DEFAULT '{}'::"text"[],
    "timezone" "text" DEFAULT 'America/New_York'::"text",
    "booking_message" "text" DEFAULT 'Your consultation has been booked! We look forward to seeing you.'::"text",
    "location" "text" DEFAULT ''::"text",
    "max_bookings_per_slot" integer DEFAULT 1,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "booking_settings_advance_days_check" CHECK ((("advance_days" >= 1) AND ("advance_days" <= 90))),
    CONSTRAINT "booking_settings_buffer_minutes_check" CHECK ((("buffer_minutes" >= 0) AND ("buffer_minutes" <= 120))),
    CONSTRAINT "booking_settings_min_notice_hours_check" CHECK ((("min_notice_hours" >= 1) AND ("min_notice_hours" <= 168))),
    CONSTRAINT "booking_settings_slot_duration_minutes_check" CHECK ((("slot_duration_minutes" >= 15) AND ("slot_duration_minutes" <= 240)))
);


ALTER TABLE "public"."booking_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."brex_sync_state" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "last_synced_posted_at" timestamp with time zone,
    "last_run_at" timestamp with time zone,
    "last_run_status" "text",
    "last_run_count" integer,
    "last_run_error" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "brex_sync_state_last_run_status_check" CHECK (("last_run_status" = ANY (ARRAY['success'::"text", 'partial'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."brex_sync_state" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."campaign_enrollments" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "campaign_id" "uuid" NOT NULL,
    "lead_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'active'::"text",
    "current_step" integer DEFAULT 0,
    "next_step_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "exited_at" timestamp with time zone,
    "exit_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "campaign_enrollments_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'paused'::"text", 'completed'::"text", 'exited'::"text", 'unsubscribed'::"text"])))
);


ALTER TABLE "public"."campaign_enrollments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."campaign_steps" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "campaign_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "step_number" integer NOT NULL,
    "name" "text",
    "channel" "text" NOT NULL,
    "delay_minutes" integer DEFAULT 0 NOT NULL,
    "delay_type" "text" DEFAULT 'after_previous'::"text",
    "subject" "text",
    "body_template" "text" NOT NULL,
    "ai_personalize" boolean DEFAULT false,
    "send_condition" "jsonb",
    "exit_condition" "jsonb",
    "total_sent" integer DEFAULT 0,
    "total_delivered" integer DEFAULT 0,
    "total_opened" integer DEFAULT 0,
    "total_replied" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "campaign_steps_channel_check" CHECK (("channel" = ANY (ARRAY['sms'::"text", 'email'::"text", 'voice'::"text"]))),
    CONSTRAINT "campaign_steps_delay_type_check" CHECK (("delay_type" = ANY (ARRAY['after_previous'::"text", 'after_enrollment'::"text", 'specific_time'::"text"])))
);


ALTER TABLE "public"."campaign_steps" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."campaigns" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "created_by" "uuid",
    "name" "text" NOT NULL,
    "description" "text",
    "type" "text" NOT NULL,
    "channel" "text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text",
    "target_criteria" "jsonb" DEFAULT '{}'::"jsonb",
    "start_at" timestamp with time zone,
    "end_at" timestamp with time zone,
    "send_window" "jsonb",
    "total_enrolled" integer DEFAULT 0,
    "total_completed" integer DEFAULT 0,
    "total_converted" integer DEFAULT 0,
    "total_unsubscribed" integer DEFAULT 0,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "smart_list_id" "uuid",
    "total_replied" integer DEFAULT 0,
    "total_opened" integer DEFAULT 0,
    "reply_rate" numeric(5,2) DEFAULT 0,
    "open_rate" numeric(5,2) DEFAULT 0,
    "revenue_attributed" numeric(12,2) DEFAULT 0,
    CONSTRAINT "campaigns_channel_check" CHECK (("channel" = ANY (ARRAY['sms'::"text", 'email'::"text", 'multi'::"text", 'voice'::"text"]))),
    CONSTRAINT "campaigns_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'active'::"text", 'paused'::"text", 'completed'::"text", 'archived'::"text"]))),
    CONSTRAINT "campaigns_type_check" CHECK (("type" = ANY (ARRAY['drip'::"text", 'broadcast'::"text", 'trigger'::"text"])))
);


ALTER TABLE "public"."campaigns" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."case_diagnosis" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "case_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "diagnosis_summary" "text" NOT NULL,
    "findings" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "icd_codes" "text"[] DEFAULT '{}'::"text"[],
    "severity" "text" DEFAULT 'moderate'::"text",
    "bone_quality" "text",
    "soft_tissue_status" "text",
    "occlusion_notes" "text",
    "risk_factors" "text"[],
    "diagnosed_by" "uuid" NOT NULL,
    "diagnosed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "case_diagnosis_severity_check" CHECK (("severity" = ANY (ARRAY['mild'::"text", 'moderate'::"text", 'severe'::"text", 'critical'::"text"])))
);


ALTER TABLE "public"."case_diagnosis" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."case_files" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "case_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "file_name" "text" NOT NULL,
    "file_url" "text" NOT NULL,
    "file_size" bigint,
    "mime_type" "text",
    "file_type" "text" DEFAULT 'photo'::"text" NOT NULL,
    "ai_analysis" "jsonb",
    "ai_analyzed_at" timestamp with time zone,
    "ai_confidence" numeric(3,2),
    "description" "text",
    "sort_order" integer DEFAULT 0,
    "uploaded_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "case_files_file_type_check" CHECK (("file_type" = ANY (ARRAY['photo'::"text", 'xray'::"text", 'panoramic'::"text", 'periapical'::"text", 'cephalometric'::"text", 'cbct'::"text", 'ct_scan'::"text", 'stl'::"text", 'intraoral'::"text", 'extraoral'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."case_files" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."case_treatment_plans" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "case_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "plan_summary" "text" NOT NULL,
    "total_estimated_cost" numeric(10,2),
    "estimated_duration" "text",
    "phases" integer DEFAULT 1,
    "items" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "alternative_options" "jsonb" DEFAULT '[]'::"jsonb",
    "planned_by" "uuid" NOT NULL,
    "approved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."case_treatment_plans" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."clinical_cases" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "lead_id" "uuid",
    "patient_name" "text" NOT NULL,
    "patient_email" "text",
    "patient_phone" "text",
    "case_number" "text" NOT NULL,
    "chief_complaint" "text" NOT NULL,
    "clinical_notes" "text",
    "status" "text" DEFAULT 'intake'::"text" NOT NULL,
    "priority" "text" DEFAULT 'normal'::"text",
    "created_by" "uuid" NOT NULL,
    "assigned_doctor_id" "uuid",
    "ai_analysis_summary" "jsonb",
    "ai_analyzed_at" timestamp with time zone,
    "share_token" "uuid" DEFAULT "gen_random_uuid"(),
    "patient_notified_at" timestamp with time zone,
    "patient_viewed_at" timestamp with time zone,
    "patient_accepted_at" timestamp with time zone,
    "diagnosed_at" timestamp with time zone,
    "treatment_planned_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "share_token_expires_at" timestamp with time zone DEFAULT ("now"() + '30 days'::interval),
    CONSTRAINT "clinical_cases_priority_check" CHECK (("priority" = ANY (ARRAY['low'::"text", 'normal'::"text", 'high'::"text", 'urgent'::"text"]))),
    CONSTRAINT "clinical_cases_status_check" CHECK (("status" = ANY (ARRAY['intake'::"text", 'analysis'::"text", 'diagnosis'::"text", 'treatment_planning'::"text", 'patient_review'::"text", 'completed'::"text", 'archived'::"text"])))
);


ALTER TABLE "public"."clinical_cases" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."competitors" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "aliases" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "typical_pricing_notes" "text",
    "weaknesses" "text",
    "our_differentiators" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."competitors" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."connector_configs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "connector_type" "text" NOT NULL,
    "enabled" boolean DEFAULT false NOT NULL,
    "credentials" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "settings" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "connector_configs_connector_type_check" CHECK (("connector_type" = ANY (ARRAY['google_ads'::"text", 'meta_capi'::"text", 'ga4'::"text", 'outbound_webhook'::"text", 'slack'::"text", 'google_reviews'::"text", 'callrail'::"text", 'cal_com'::"text", 'carestack'::"text", 'windsor'::"text", 'stripe'::"text", 'brex'::"text"])))
);


ALTER TABLE "public"."connector_configs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."connector_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "lead_id" "uuid",
    "connector_type" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "success" boolean DEFAULT false NOT NULL,
    "status_code" integer,
    "error_message" "text",
    "response_id" "text",
    "dispatched_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."connector_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."consent_capture_tokens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "lead_id" "uuid" NOT NULL,
    "token" "text" NOT NULL,
    "channels" "text"[] DEFAULT ARRAY['sms'::"text", 'email'::"text"] NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "confirmed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "consent_capture_tokens_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'confirmed'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."consent_capture_tokens" OWNER TO "postgres";


COMMENT ON TABLE "public"."consent_capture_tokens" IS 'Single-use, expiring tokens backing the /optin consent-capture page.';



CREATE TABLE IF NOT EXISTS "public"."consent_log" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "lead_id" "uuid" NOT NULL,
    "channel" "text" NOT NULL,
    "consent_given" boolean NOT NULL,
    "granted_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "source" "text",
    "source_text" "text",
    "ip_address" "inet",
    "user_agent" "text",
    "actor_user_id" "uuid",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "consent_log_channel_check" CHECK (("channel" = ANY (ARRAY['sms'::"text", 'email'::"text", 'voice'::"text"])))
);


ALTER TABLE "public"."consent_log" OWNER TO "postgres";


COMMENT ON TABLE "public"."consent_log" IS 'Append-only TCPA/CAN-SPAM audit trail.';



CREATE TABLE IF NOT EXISTS "public"."contract_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "contract_id" "uuid" NOT NULL,
    "event_type" "text" NOT NULL,
    "actor_type" "text" DEFAULT 'user'::"text" NOT NULL,
    "actor_id" "text",
    "payload" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "contract_events_actor_type_check" CHECK (("actor_type" = ANY (ARRAY['user'::"text", 'patient'::"text", 'system'::"text", 'ai_agent'::"text"])))
);


ALTER TABLE "public"."contract_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contract_templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "sections" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "required_variables" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "published_at" timestamp with time zone,
    "published_by" "uuid",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "contract_templates_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'published'::"text", 'archived'::"text"])))
);


ALTER TABLE "public"."contract_templates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."conversation_analyses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "lead_id" "uuid" NOT NULL,
    "emotional_score" integer,
    "engagement_score" integer,
    "trust_score" integer,
    "urgency_score" integer,
    "patient_tone" "text",
    "staff_tone" "text",
    "tone_alignment" "text",
    "sales_pressure_level" integer,
    "empathy_level" integer,
    "active_listening_score" integer,
    "objection_handling_quality" integer,
    "rapport_building_score" integer,
    "patient_openness" integer,
    "patient_buying_signals" integer,
    "patient_resistance" integer,
    "response_enthusiasm" "text",
    "message_count" integer,
    "avg_response_time_seconds" integer,
    "longest_message_by" "text",
    "conversation_flow" "text",
    "turning_points" "jsonb" DEFAULT '[]'::"jsonb",
    "red_flags" "jsonb" DEFAULT '[]'::"jsonb",
    "opportunities" "jsonb" DEFAULT '[]'::"jsonb",
    "coaching_notes" "text",
    "improvement_areas" "jsonb" DEFAULT '[]'::"jsonb",
    "things_done_well" "jsonb" DEFAULT '[]'::"jsonb",
    "phi_detected" boolean DEFAULT false,
    "phi_details" "jsonb" DEFAULT '[]'::"jsonb",
    "compliance_score" integer,
    "compliance_issues" "jsonb" DEFAULT '[]'::"jsonb",
    "analyzed_at" timestamp with time zone DEFAULT "now"(),
    "model_used" "text",
    "analysis_version" integer DEFAULT 1,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "conversation_analyses_active_listening_score_check" CHECK ((("active_listening_score" >= 0) AND ("active_listening_score" <= 10))),
    CONSTRAINT "conversation_analyses_compliance_score_check" CHECK ((("compliance_score" >= 0) AND ("compliance_score" <= 100))),
    CONSTRAINT "conversation_analyses_emotional_score_check" CHECK ((("emotional_score" >= 0) AND ("emotional_score" <= 10))),
    CONSTRAINT "conversation_analyses_empathy_level_check" CHECK ((("empathy_level" >= 0) AND ("empathy_level" <= 10))),
    CONSTRAINT "conversation_analyses_engagement_score_check" CHECK ((("engagement_score" >= 0) AND ("engagement_score" <= 10))),
    CONSTRAINT "conversation_analyses_objection_handling_quality_check" CHECK ((("objection_handling_quality" >= 0) AND ("objection_handling_quality" <= 10))),
    CONSTRAINT "conversation_analyses_patient_buying_signals_check" CHECK ((("patient_buying_signals" >= 0) AND ("patient_buying_signals" <= 10))),
    CONSTRAINT "conversation_analyses_patient_openness_check" CHECK ((("patient_openness" >= 0) AND ("patient_openness" <= 10))),
    CONSTRAINT "conversation_analyses_patient_resistance_check" CHECK ((("patient_resistance" >= 0) AND ("patient_resistance" <= 10))),
    CONSTRAINT "conversation_analyses_rapport_building_score_check" CHECK ((("rapport_building_score" >= 0) AND ("rapport_building_score" <= 10))),
    CONSTRAINT "conversation_analyses_sales_pressure_level_check" CHECK ((("sales_pressure_level" >= 0) AND ("sales_pressure_level" <= 10))),
    CONSTRAINT "conversation_analyses_trust_score_check" CHECK ((("trust_score" >= 0) AND ("trust_score" <= 10))),
    CONSTRAINT "conversation_analyses_urgency_score_check" CHECK ((("urgency_score" >= 0) AND ("urgency_score" <= 10)))
);


ALTER TABLE "public"."conversation_analyses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."conversation_technique_summaries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "lead_id" "uuid" NOT NULL,
    "total_techniques_used" integer DEFAULT 0,
    "unique_techniques_used" integer DEFAULT 0,
    "techniques_breakdown" "jsonb" DEFAULT '{}'::"jsonb",
    "category_breakdown" "jsonb" DEFAULT '{}'::"jsonb",
    "most_effective_technique" "text",
    "technique_diversity_score" numeric(3,2) DEFAULT 0,
    "approach_adaptation_score" numeric(3,2) DEFAULT 0,
    "final_engagement_temperature" integer,
    "final_buying_readiness" integer,
    "engagement_trend" "text",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "conversation_technique_summarie_approach_adaptation_score_check" CHECK ((("approach_adaptation_score" >= (0)::numeric) AND ("approach_adaptation_score" <= (1)::numeric))),
    CONSTRAINT "conversation_technique_summarie_technique_diversity_score_check" CHECK ((("technique_diversity_score" >= (0)::numeric) AND ("technique_diversity_score" <= (1)::numeric))),
    CONSTRAINT "conversation_technique_summaries_engagement_trend_check" CHECK (("engagement_trend" = ANY (ARRAY['improving'::"text", 'stable'::"text", 'declining'::"text"])))
);


ALTER TABLE "public"."conversation_technique_summaries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."conversations" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "lead_id" "uuid" NOT NULL,
    "channel" "text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text",
    "subject" "text",
    "ai_enabled" boolean DEFAULT true,
    "ai_mode" "text" DEFAULT 'assist'::"text",
    "sentiment" "text",
    "intent" "text",
    "last_message_at" timestamp with time zone,
    "last_message_preview" "text",
    "unread_count" integer DEFAULT 0,
    "message_count" integer DEFAULT 0,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "active_agent" "text" DEFAULT 'setter'::"text",
    "agent_assigned_at" timestamp with time zone DEFAULT "now"(),
    "agent_handoff_count" integer DEFAULT 0,
    "summary" "text",
    "summary_updated_at" timestamp with time zone,
    "summary_message_count" integer DEFAULT 0,
    CONSTRAINT "conversations_active_agent_check" CHECK (("active_agent" = ANY (ARRAY['setter'::"text", 'closer'::"text", 'none'::"text"]))),
    CONSTRAINT "conversations_ai_mode_check" CHECK (("ai_mode" = ANY (ARRAY['auto'::"text", 'assist'::"text", 'off'::"text"]))),
    CONSTRAINT "conversations_channel_check" CHECK (("channel" = ANY (ARRAY['sms'::"text", 'email'::"text", 'web_chat'::"text", 'whatsapp'::"text"]))),
    CONSTRAINT "conversations_sentiment_check" CHECK (("sentiment" = ANY (ARRAY['positive'::"text", 'neutral'::"text", 'negative'::"text", 'frustrated'::"text"]))),
    CONSTRAINT "conversations_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'paused'::"text", 'closed'::"text", 'archived'::"text"])))
);


ALTER TABLE "public"."conversations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cron_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "cron" "text" NOT NULL,
    "status" "text" NOT NULL,
    "items_processed" integer DEFAULT 0 NOT NULL,
    "duration_ms" integer,
    "error" "text",
    "ran_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "cron_runs_status_check" CHECK (("status" = ANY (ARRAY['ok'::"text", 'skipped'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."cron_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cross_channel_deliveries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "lead_id" "uuid" NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "triggered_by_channel" "text" NOT NULL,
    "delivered_via_channel" "text" NOT NULL,
    "content_type" "text" NOT NULL,
    "content_asset_id" "uuid",
    "message_id" "uuid",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "error_message" "text",
    "agent_type" "text",
    "tool_name" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "cross_channel_deliveries_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'sent'::"text", 'delivered'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."cross_channel_deliveries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."daily_analytics" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "date" "date" NOT NULL,
    "new_leads" integer DEFAULT 0,
    "qualified_leads" integer DEFAULT 0,
    "disqualified_leads" integer DEFAULT 0,
    "consultations_scheduled" integer DEFAULT 0,
    "consultations_completed" integer DEFAULT 0,
    "no_shows" integer DEFAULT 0,
    "contracts_signed" integer DEFAULT 0,
    "treatment_value_presented" numeric(12,2) DEFAULT 0,
    "treatment_value_accepted" numeric(12,2) DEFAULT 0,
    "revenue_closed" numeric(12,2) DEFAULT 0,
    "sms_sent" integer DEFAULT 0,
    "sms_received" integer DEFAULT 0,
    "emails_sent" integer DEFAULT 0,
    "emails_opened" integer DEFAULT 0,
    "ai_interactions" integer DEFAULT 0,
    "ai_cost_usd" numeric(10,4) DEFAULT 0,
    "leads_by_source" "jsonb" DEFAULT '{}'::"jsonb",
    "conversions_by_source" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."daily_analytics" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ehr_sync_state" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "ehr_source" "text" DEFAULT 'carestack'::"text" NOT NULL,
    "resource" "text" NOT NULL,
    "last_synced_at" timestamp with time zone,
    "continue_token" "text",
    "last_run_at" timestamp with time zone,
    "last_run_status" "text",
    "last_run_count" integer,
    "last_run_error" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "ehr_sync_state_last_run_status_check" CHECK (("last_run_status" = ANY (ARRAY['success'::"text", 'failed'::"text", 'partial'::"text"]))),
    CONSTRAINT "ehr_sync_state_resource_check" CHECK (("resource" = ANY (ARRAY['patients'::"text", 'appointments'::"text", 'treatment_procedures'::"text", 'existing_treatment_procedures'::"text", 'invoices'::"text", 'accounting_procedures'::"text", 'accounting_transactions'::"text", 'treatment_plans'::"text", 'treatment_phases'::"text", 'potential_patients'::"text"])))
);


ALTER TABLE "public"."ehr_sync_state" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."escalations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "conversation_id" "uuid",
    "lead_id" "uuid",
    "reason" "text" NOT NULL,
    "ai_notes" "text",
    "ai_draft_response" "text",
    "ai_confidence" numeric(3,2),
    "agent_type" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "claimed_by" "uuid",
    "claimed_at" timestamp with time zone,
    "resolved_at" timestamp with time zone,
    "resolution_notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "escalations_reason_check" CHECK (("reason" = ANY (ARRAY['low_confidence'::"text", 'patient_requested_human'::"text", 'stop_word_detected'::"text", 'compliance_flag'::"text", 'max_attempts_reached'::"text", 'agent_failure'::"text", 'sentiment_drop'::"text"]))),
    CONSTRAINT "escalations_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'claimed'::"text", 'resolved'::"text", 'dismissed'::"text"])))
);


ALTER TABLE "public"."escalations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."events" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "lead_id" "uuid",
    "event_type" "text" NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb",
    "capi_status" "text" DEFAULT 'pending'::"text",
    "capi_attempted_at" timestamp with time zone,
    "gads_status" "text" DEFAULT 'pending'::"text",
    "gads_attempted_at" timestamp with time zone,
    "occurred_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "events_capi_status_check" CHECK (("capi_status" = ANY (ARRAY['pending'::"text", 'sent'::"text", 'failed'::"text", 'skipped'::"text", 'na'::"text"]))),
    CONSTRAINT "events_gads_status_check" CHECK (("gads_status" = ANY (ARRAY['pending'::"text", 'sent'::"text", 'failed'::"text", 'skipped'::"text", 'na'::"text"])))
);


ALTER TABLE "public"."events" OWNER TO "postgres";


COMMENT ON TABLE "public"."events" IS 'Append-only system event log. Queue for CAPI + Google Ads forwarders.';



CREATE TABLE IF NOT EXISTS "public"."expense_line_items" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "source" "text" DEFAULT 'brex'::"text" NOT NULL,
    "external_id" "text" NOT NULL,
    "posted_at" timestamp with time zone NOT NULL,
    "amount_cents" integer NOT NULL,
    "amount" numeric(12,2) GENERATED ALWAYS AS ((("amount_cents")::numeric / (100)::numeric)) STORED,
    "currency" "text" DEFAULT 'USD'::"text" NOT NULL,
    "vendor_name" "text",
    "vendor_normalized" "text",
    "description" "text",
    "card_last4" "text",
    "user_email" "text",
    "category" "text" DEFAULT 'other'::"text" NOT NULL,
    "subcategory" "text",
    "category_overridden" boolean DEFAULT false,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "raw_payload" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "expense_line_items_category_check" CHECK (("category" = ANY (ARRAY['acquisition'::"text", 'platform'::"text", 'other'::"text"]))),
    CONSTRAINT "expense_line_items_source_check" CHECK (("source" = ANY (ARRAY['brex'::"text", 'manual'::"text"])))
);


ALTER TABLE "public"."expense_line_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."financing_applications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "lead_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "applicant_data_encrypted" "text" DEFAULT ''::"text" NOT NULL,
    "applicant_ssn_hash" "text",
    "requested_amount" numeric(10,2),
    "approved_lender_slug" "text",
    "approved_amount" numeric(10,2),
    "approved_terms" "jsonb",
    "current_waterfall_step" integer DEFAULT 0,
    "waterfall_config" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "consent_given_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "consent_ip_address" "text",
    "share_token" "text",
    "expires_at" timestamp with time zone DEFAULT ("now"() + '24:00:00'::interval) NOT NULL,
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "financing_applications_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'in_progress'::"text", 'approved'::"text", 'denied'::"text", 'error'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."financing_applications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."financing_lender_configs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "lender_slug" "text" NOT NULL,
    "display_name" "text" NOT NULL,
    "is_active" boolean DEFAULT false,
    "priority_order" integer DEFAULT 0 NOT NULL,
    "credentials_encrypted" "text",
    "config" "jsonb" DEFAULT '{}'::"jsonb",
    "integration_type" "text" DEFAULT 'link'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "financing_lender_configs_integration_type_check" CHECK (("integration_type" = ANY (ARRAY['api'::"text", 'link'::"text", 'iframe'::"text"]))),
    CONSTRAINT "financing_lender_configs_lender_slug_check" CHECK (("lender_slug" = ANY (ARRAY['carecredit'::"text", 'sunbit'::"text", 'affirm'::"text", 'cherry'::"text", 'alpheon'::"text", 'proceed'::"text", 'lendingclub'::"text"])))
);


ALTER TABLE "public"."financing_lender_configs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."financing_submissions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "application_id" "uuid" NOT NULL,
    "lead_id" "uuid" NOT NULL,
    "lender_slug" "text" NOT NULL,
    "waterfall_step" integer NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "external_application_id" "text",
    "application_url" "text",
    "response_data" "jsonb",
    "error_message" "text",
    "submitted_at" timestamp with time zone,
    "responded_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "financing_submissions_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'submitted'::"text", 'approved'::"text", 'denied'::"text", 'error'::"text", 'timeout'::"text", 'link_sent'::"text"])))
);


ALTER TABLE "public"."financing_submissions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."growth_studio_outbox" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid",
    "lead_id" "uuid",
    "external_ref" "text",
    "stage" "text",
    "value_cents" bigint,
    "request_id" bigint,
    "status" "text" DEFAULT 'pending'::"text",
    "attempts" integer DEFAULT 0,
    "last_error" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "delivered_at" timestamp with time zone
);


ALTER TABLE "public"."growth_studio_outbox" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."growth_studio_webhook_config" (
    "id" boolean DEFAULT true NOT NULL,
    "url" "text" NOT NULL,
    "bearer" "text" NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "growth_studio_webhook_config_id_check" CHECK ("id")
);


ALTER TABLE "public"."growth_studio_webhook_config" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."hipaa_audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "event_type" "text" NOT NULL,
    "severity" "text" DEFAULT 'info'::"text" NOT NULL,
    "actor_type" "text" NOT NULL,
    "actor_id" "text",
    "resource_type" "text",
    "resource_id" "text",
    "description" "text" NOT NULL,
    "phi_categories" "jsonb" DEFAULT '[]'::"jsonb",
    "remediation_action" "text",
    "remediation_status" "text" DEFAULT 'none'::"text",
    "ip_address" "text",
    "user_agent" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."hipaa_audit_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."invoices" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "patient_id" "uuid",
    "ehr_invoice_id" integer NOT NULL,
    "ehr_invoice_number" integer,
    "ehr_source" "text" DEFAULT 'carestack'::"text" NOT NULL,
    "amount" numeric(12,2) NOT NULL,
    "unapplied_amount" numeric(12,2),
    "ehr_provider_id" integer,
    "ehr_location_id" integer,
    "payment_category" "text",
    "invoice_type" integer,
    "invoice_source" integer,
    "payment_type_id" integer,
    "payment_date" timestamp with time zone,
    "is_nsf" boolean DEFAULT false,
    "is_deleted" boolean DEFAULT false,
    "forwarded" boolean DEFAULT false,
    "forwarded_at" timestamp with time zone,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "ehr_last_updated_on" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."invoices" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lead_activities" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "lead_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "activity_type" "text" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "lead_activities_activity_type_check" CHECK (("activity_type" = ANY (ARRAY['created'::"text", 'updated'::"text", 'stage_changed'::"text", 'status_changed'::"text", 'score_updated'::"text", 'note_added'::"text", 'email_sent'::"text", 'email_opened'::"text", 'email_clicked'::"text", 'sms_sent'::"text", 'sms_received'::"text", 'call_made'::"text", 'call_received'::"text", 'appointment_scheduled'::"text", 'appointment_completed'::"text", 'appointment_no_show'::"text", 'treatment_presented'::"text", 'contract_sent'::"text", 'contract_signed'::"text", 'financing_applied'::"text", 'financing_approved'::"text", 'financing_denied'::"text", 'assigned'::"text", 'unassigned'::"text", 'tagged'::"text", 'disqualified'::"text", 'requalified'::"text", 'ai_interaction'::"text", 'campaign_enrolled'::"text", 'campaign_completed'::"text"])))
);


ALTER TABLE "public"."lead_activities" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lead_competitor_mentions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "lead_id" "uuid" NOT NULL,
    "competitor_id" "uuid",
    "matched_term" "text",
    "quote" "text",
    "detected_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lead_competitor_mentions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lead_engagement_assessments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "lead_id" "uuid" NOT NULL,
    "message_index" integer NOT NULL,
    "engagement_temperature" integer,
    "resistance_level" integer,
    "buying_readiness" integer,
    "emotional_state" "text",
    "recommended_approach" "text",
    "techniques_to_try_next" "jsonb" DEFAULT '[]'::"jsonb",
    "techniques_to_avoid" "jsonb" DEFAULT '[]'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "lead_engagement_assessments_buying_readiness_check" CHECK ((("buying_readiness" >= 1) AND ("buying_readiness" <= 10))),
    CONSTRAINT "lead_engagement_assessments_engagement_temperature_check" CHECK ((("engagement_temperature" >= 1) AND ("engagement_temperature" <= 10))),
    CONSTRAINT "lead_engagement_assessments_resistance_level_check" CHECK ((("resistance_level" >= 1) AND ("resistance_level" <= 10)))
);


ALTER TABLE "public"."lead_engagement_assessments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lead_enrichment" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "lead_id" "uuid" NOT NULL,
    "enrichment_type" "text" NOT NULL,
    "enrichment_source" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "data" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "error_message" "text",
    "confidence_score" numeric(3,2),
    "enriched_at" timestamp with time zone DEFAULT "now"(),
    "expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "lead_enrichment_confidence_score_check" CHECK ((("confidence_score" >= (0)::numeric) AND ("confidence_score" <= (1)::numeric))),
    CONSTRAINT "lead_enrichment_enrichment_type_check" CHECK (("enrichment_type" = ANY (ARRAY['email_validation'::"text", 'phone_validation'::"text", 'ip_geolocation'::"text", 'google_ads_keyword'::"text", 'website_behavior'::"text", 'credit_prequal'::"text"]))),
    CONSTRAINT "lead_enrichment_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'success'::"text", 'failed'::"text", 'skipped'::"text"])))
);


ALTER TABLE "public"."lead_enrichment" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lead_nurture_state" (
    "lead_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "current_stage" "text",
    "attempts" integer DEFAULT 0 NOT NULL,
    "last_touch_at" timestamp with time zone,
    "next_action_at" timestamp with time zone,
    "paused" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lead_nurture_state" OWNER TO "postgres";


COMMENT ON TABLE "public"."lead_nurture_state" IS 'Per-lead re-engagement ladder cursor (Phase 3).';



CREATE TABLE IF NOT EXISTS "public"."lead_sources" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "type" "text" NOT NULL,
    "utm_source" "text",
    "utm_medium" "text",
    "utm_campaign" "text",
    "cost_per_lead" numeric(10,2),
    "is_active" boolean DEFAULT true,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "lead_sources_type_check" CHECK (("type" = ANY (ARRAY['google_ads'::"text", 'meta_ads'::"text", 'website_form'::"text", 'landing_page'::"text", 'referral'::"text", 'walk_in'::"text", 'phone'::"text", 'email_campaign'::"text", 'sms_campaign'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."lead_sources" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lead_tags" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "lead_id" "uuid" NOT NULL,
    "tag_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "tagged_by" "uuid",
    "tagged_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."lead_tags" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."leads" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "first_name" "text" NOT NULL,
    "last_name" "text",
    "email" "text",
    "phone" "text",
    "phone_formatted" "text",
    "avatar_url" "text",
    "date_of_birth" "date",
    "age" integer,
    "gender" "text",
    "city" "text",
    "state" "text",
    "zip_code" "text",
    "timezone" "text" DEFAULT 'America/New_York'::"text",
    "preferred_language" "text" DEFAULT 'en'::"text",
    "dental_condition" "text",
    "dental_condition_details" "text",
    "current_dental_situation" "text",
    "has_dentures" boolean,
    "has_dental_insurance" boolean,
    "insurance_provider" "text",
    "insurance_details" "jsonb",
    "medical_conditions" "text"[],
    "medications" "text"[],
    "smoker" boolean,
    "financing_interest" "text",
    "budget_range" "text",
    "financing_approved" boolean,
    "financing_amount" numeric(10,2),
    "stage_id" "uuid",
    "status" "text" DEFAULT 'new'::"text" NOT NULL,
    "source_id" "uuid",
    "source_type" "text",
    "utm_source" "text",
    "utm_medium" "text",
    "utm_campaign" "text",
    "utm_content" "text",
    "utm_term" "text",
    "landing_page_url" "text",
    "referrer_url" "text",
    "gclid" "text",
    "fbclid" "text",
    "ai_score" integer DEFAULT 0,
    "ai_qualification" "text" DEFAULT 'unscored'::"text",
    "ai_score_breakdown" "jsonb" DEFAULT '{}'::"jsonb",
    "ai_score_updated_at" timestamp with time zone,
    "ai_summary" "text",
    "total_messages_sent" integer DEFAULT 0,
    "total_messages_received" integer DEFAULT 0,
    "total_emails_sent" integer DEFAULT 0,
    "total_emails_opened" integer DEFAULT 0,
    "total_sms_sent" integer DEFAULT 0,
    "total_sms_received" integer DEFAULT 0,
    "last_contacted_at" timestamp with time zone,
    "last_responded_at" timestamp with time zone,
    "response_time_avg_minutes" integer,
    "engagement_score" integer DEFAULT 0,
    "assigned_to" "uuid",
    "consultation_date" timestamp with time zone,
    "consultation_type" "text",
    "treatment_date" timestamp with time zone,
    "treatment_value" numeric(10,2),
    "actual_revenue" numeric(10,2),
    "tags" "text"[] DEFAULT '{}'::"text"[],
    "custom_fields" "jsonb" DEFAULT '{}'::"jsonb",
    "notes" "text",
    "disqualified_reason" "text",
    "lost_reason" "text",
    "no_show_count" integer DEFAULT 0,
    "first_contact_at" timestamp with time zone,
    "qualified_at" timestamp with time zone,
    "converted_at" timestamp with time zone,
    "lost_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "enrichment_score" integer DEFAULT 0,
    "enrichment_status" "text" DEFAULT 'pending'::"text",
    "enriched_at" timestamp with time zone,
    "email_valid" boolean,
    "phone_valid" boolean,
    "phone_line_type" "text",
    "ip_address" "text",
    "ip_city" "text",
    "ip_region" "text",
    "ip_country" "text",
    "distance_to_practice_miles" numeric(8,1),
    "ai_autopilot_override" "text" DEFAULT 'default'::"text",
    "personality_profile" "jsonb",
    "voice_consent" boolean DEFAULT false,
    "voice_consent_at" timestamp with time zone,
    "voice_consent_source" "text",
    "voice_opt_out" boolean DEFAULT false,
    "voice_opt_out_at" timestamp with time zone,
    "do_not_call" boolean DEFAULT false,
    "financial_qualification_tier" "text",
    "financing_readiness_score" integer DEFAULT 0,
    "financial_signals" "jsonb" DEFAULT '{}'::"jsonb",
    "financing_link_sent_at" timestamp with time zone,
    "preferred_monthly_budget" integer,
    "has_hsa_fsa" boolean,
    "estimated_down_payment" integer,
    "financial_coaching_notes" "text",
    "financing_application_id" "uuid",
    "credit_tier" "text",
    "sms_consent" boolean DEFAULT false NOT NULL,
    "sms_consent_at" timestamp with time zone,
    "sms_consent_source" "text",
    "email_consent" boolean DEFAULT false NOT NULL,
    "email_consent_at" timestamp with time zone,
    "email_consent_source" "text",
    "sms_opt_out" boolean DEFAULT false NOT NULL,
    "sms_opt_out_at" timestamp with time zone,
    "email_opt_out" boolean DEFAULT false NOT NULL,
    "email_opt_out_at" timestamp with time zone,
    "email_hash" "text",
    "phone_hash" "text",
    "fbc" "text",
    "fbp" "text",
    "external_ref" "text",
    "sms_consent_status" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "email_consent_status" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "voice_consent_status" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "financial_qualification_status" "text" DEFAULT 'unassessed'::"text" NOT NULL,
    CONSTRAINT "chk_leads_pii_encrypted" CHECK (((("email" IS NULL) OR ("email" ~~ 'enc::%'::"text")) AND (("phone" IS NULL) OR ("phone" ~~ 'enc::%'::"text")) AND (("phone_formatted" IS NULL) OR ("phone_formatted" ~~ 'enc::%'::"text")) AND (("insurance_provider" IS NULL) OR ("insurance_provider" ~~ 'enc::%'::"text")))),
    CONSTRAINT "leads_ai_qualification_check" CHECK (("ai_qualification" = ANY (ARRAY['hot'::"text", 'warm'::"text", 'cold'::"text", 'unqualified'::"text", 'unscored'::"text"]))),
    CONSTRAINT "leads_ai_score_check" CHECK ((("ai_score" >= 0) AND ("ai_score" <= 100))),
    CONSTRAINT "leads_budget_range_check" CHECK (("budget_range" = ANY (ARRAY['under_10k'::"text", '10k_15k'::"text", '15k_20k'::"text", '20k_25k'::"text", '25k_30k'::"text", 'over_30k'::"text", 'unknown'::"text"]))),
    CONSTRAINT "leads_consultation_type_check" CHECK (("consultation_type" = ANY (ARRAY['in_person'::"text", 'virtual'::"text", 'phone'::"text"]))),
    CONSTRAINT "leads_dental_condition_check" CHECK (("dental_condition" = ANY (ARRAY['missing_all_upper'::"text", 'missing_all_lower'::"text", 'missing_all_both'::"text", 'missing_multiple'::"text", 'failing_teeth'::"text", 'denture_problems'::"text", 'other'::"text"]))),
    CONSTRAINT "leads_email_consent_status_check" CHECK (("email_consent_status" = ANY (ARRAY['granted'::"text", 'declined'::"text", 'unknown'::"text"]))),
    CONSTRAINT "leads_financial_qualification_status_check" CHECK (("financial_qualification_status" = ANY (ARRAY['unassessed'::"text", 'assessed'::"text"]))),
    CONSTRAINT "leads_financial_qualification_tier_check" CHECK (("financial_qualification_tier" = ANY (ARRAY['tier_a'::"text", 'tier_b'::"text", 'tier_c'::"text", 'tier_d'::"text"]))),
    CONSTRAINT "leads_financing_interest_check" CHECK (("financing_interest" = ANY (ARRAY['cash_pay'::"text", 'financing_needed'::"text", 'insurance_only'::"text", 'undecided'::"text"]))),
    CONSTRAINT "leads_sms_consent_status_check" CHECK (("sms_consent_status" = ANY (ARRAY['granted'::"text", 'declined'::"text", 'unknown'::"text"]))),
    CONSTRAINT "leads_status_check" CHECK (("status" = ANY (ARRAY['new'::"text", 'contacted'::"text", 'qualified'::"text", 'consultation_scheduled'::"text", 'consultation_completed'::"text", 'treatment_presented'::"text", 'financing'::"text", 'contract_sent'::"text", 'contract_signed'::"text", 'scheduled'::"text", 'in_treatment'::"text", 'completed'::"text", 'lost'::"text", 'disqualified'::"text", 'no_show'::"text", 'unresponsive'::"text", 'dormant'::"text"]))),
    CONSTRAINT "leads_voice_consent_status_check" CHECK (("voice_consent_status" = ANY (ARRAY['granted'::"text", 'declined'::"text", 'unknown'::"text"])))
);


ALTER TABLE "public"."leads" OWNER TO "postgres";


COMMENT ON COLUMN "public"."leads"."ai_autopilot_override" IS 'Per-lead AI override: default, force_on, force_off, assist_only';



COMMENT ON COLUMN "public"."leads"."personality_profile" IS 'AI-analyzed personality profile: type, traits, communication style, buying signals';



COMMENT ON COLUMN "public"."leads"."financial_qualification_tier" IS 'Text-derived financing SIGNAL (regex/keyword), NOT a credit grade. NULL until assessed.';



COMMENT ON COLUMN "public"."leads"."financing_readiness_score" IS 'AI-calculated 0-100 score indicating when to send financing links';



COMMENT ON COLUMN "public"."leads"."financial_signals" IS 'JSON of financial signals extracted from conversations (insurance, budget, savings, barriers)';



COMMENT ON COLUMN "public"."leads"."preferred_monthly_budget" IS 'Monthly budget detected from conversation (e.g. "I can do around $200/mo")';



COMMENT ON COLUMN "public"."leads"."has_hsa_fsa" IS 'Whether lead mentioned having HSA/FSA pre-tax health savings';



COMMENT ON COLUMN "public"."leads"."estimated_down_payment" IS 'Down payment capacity detected from conversation';



COMMENT ON COLUMN "public"."leads"."sms_consent_status" IS 'Tri-state derived from sms_consent/sms_opt_out + explicit ingest signal: granted | declined | unknown. unknown = eligible for consent-capture flow.';



COMMENT ON COLUMN "public"."leads"."email_consent_status" IS 'Tri-state email consent: granted | declined | unknown.';



COMMENT ON COLUMN "public"."leads"."voice_consent_status" IS 'Tri-state voice consent: granted | declined | unknown (declined also when do_not_call).';



COMMENT ON COLUMN "public"."leads"."financial_qualification_status" IS 'unassessed = no financing signal yet; assessed = the text-derived qualifier ran. NOT a credit check.';



CREATE TABLE IF NOT EXISTS "public"."mass_send_idempotency" (
    "organization_id" "uuid" NOT NULL,
    "idempotency_key" "text" NOT NULL,
    "route" "text" NOT NULL,
    "response" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."mass_send_idempotency" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."message_technique_tracking" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "lead_id" "uuid" NOT NULL,
    "message_index" integer NOT NULL,
    "agent_type" "text" NOT NULL,
    "technique_id" "text" NOT NULL,
    "technique_category" "text" NOT NULL,
    "technique_confidence" numeric(3,2),
    "predicted_effectiveness" "text",
    "actual_effectiveness" "text",
    "context_note" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "message_technique_tracking_actual_effectiveness_check" CHECK (("actual_effectiveness" = ANY (ARRAY['effective'::"text", 'neutral'::"text", 'backfired'::"text", 'too_early'::"text"]))),
    CONSTRAINT "message_technique_tracking_agent_type_check" CHECK (("agent_type" = ANY (ARRAY['setter'::"text", 'closer'::"text"]))),
    CONSTRAINT "message_technique_tracking_predicted_effectiveness_check" CHECK (("predicted_effectiveness" = ANY (ARRAY['effective'::"text", 'neutral'::"text", 'backfired'::"text", 'too_early'::"text"]))),
    CONSTRAINT "message_technique_tracking_technique_confidence_check" CHECK ((("technique_confidence" >= (0)::numeric) AND ("technique_confidence" <= (1)::numeric)))
);


ALTER TABLE "public"."message_technique_tracking" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."messages" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "lead_id" "uuid" NOT NULL,
    "direction" "text" NOT NULL,
    "channel" "text" NOT NULL,
    "body" "text" NOT NULL,
    "html_body" "text",
    "subject" "text",
    "sender_type" "text" NOT NULL,
    "sender_id" "uuid",
    "sender_name" "text",
    "status" "text" DEFAULT 'pending'::"text",
    "error_message" "text",
    "external_id" "text",
    "email_from" "text",
    "email_to" "text",
    "email_cc" "text"[],
    "email_attachments" "jsonb",
    "ai_generated" boolean DEFAULT false,
    "ai_confidence" numeric(3,2),
    "ai_model" "text",
    "ai_prompt_tokens" integer,
    "ai_completion_tokens" integer,
    "opened_at" timestamp with time zone,
    "clicked_at" timestamp with time zone,
    "replied_at" timestamp with time zone,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "agent_id" "uuid",
    CONSTRAINT "messages_channel_check" CHECK (("channel" = ANY (ARRAY['sms'::"text", 'email'::"text", 'web_chat'::"text", 'whatsapp'::"text"]))),
    CONSTRAINT "messages_direction_check" CHECK (("direction" = ANY (ARRAY['inbound'::"text", 'outbound'::"text"]))),
    CONSTRAINT "messages_sender_type_check" CHECK (("sender_type" = ANY (ARRAY['lead'::"text", 'user'::"text", 'ai'::"text", 'system'::"text"]))),
    CONSTRAINT "messages_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'queued'::"text", 'sent'::"text", 'delivered'::"text", 'read'::"text", 'failed'::"text", 'bounced'::"text"])))
);


ALTER TABLE "public"."messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."oauth_states" (
    "state" "text" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '00:15:00'::interval) NOT NULL,
    CONSTRAINT "oauth_states_provider_check" CHECK (("provider" = ANY (ARRAY['google'::"text", 'meta'::"text"])))
);


ALTER TABLE "public"."oauth_states" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."org_goals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "metric" "text" NOT NULL,
    "target_value" numeric(14,2) NOT NULL,
    "period_start" "date" NOT NULL,
    "period_end" "date" NOT NULL,
    "label" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "org_goals_metric_check" CHECK (("metric" = ANY (ARRAY['pipeline_value'::"text", 'conversions'::"text", 'revenue'::"text", 'bookings'::"text", 'qualification_rate'::"text"])))
);


ALTER TABLE "public"."org_goals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."organizations" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "logo_url" "text",
    "website" "text",
    "phone" "text",
    "email" "text",
    "address" "jsonb",
    "settings" "jsonb" DEFAULT '{}'::"jsonb",
    "subscription_tier" "text" DEFAULT 'trial'::"text",
    "subscription_status" "text" DEFAULT 'active'::"text",
    "trial_ends_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "autopilot_enabled" boolean DEFAULT false,
    "autopilot_confidence_threshold" numeric(3,2) DEFAULT 0.75,
    "autopilot_mode" "text" DEFAULT 'full'::"text",
    "autopilot_response_delay_min" integer DEFAULT 30,
    "autopilot_response_delay_max" integer DEFAULT 180,
    "autopilot_max_messages_per_hour" integer DEFAULT 10,
    "autopilot_active_hours_start" integer DEFAULT 8,
    "autopilot_active_hours_end" integer DEFAULT 21,
    "autopilot_stop_words" "text"[] DEFAULT ARRAY['stop'::"text", 'unsubscribe'::"text", 'opt out'::"text", 'opt-out'::"text", 'talk to a person'::"text", 'speak to someone'::"text", 'talk to a human'::"text", 'real person'::"text", 'human please'::"text", 'cancel'::"text"],
    "autopilot_paused" boolean DEFAULT false,
    "autopilot_speed_to_lead" boolean DEFAULT true,
    "autopilot_schedule" "jsonb",
    "voice_enabled" boolean DEFAULT false,
    "voice_provider" "text" DEFAULT 'retell'::"text",
    "voice_retell_agent_id" "text",
    "voice_retell_api_key_encrypted" "text",
    "voice_greeting" "text" DEFAULT 'Hi, this is the patient coordinator calling from {practice_name}. Is this {first_name}?'::"text",
    "voice_voicemail_message" "text" DEFAULT 'Hi {first_name}, this is {practice_name} calling about your recent inquiry. We would love to help you explore your options. Please call us back at your convenience.'::"text",
    "voice_max_call_duration_seconds" integer DEFAULT 600,
    "voice_max_outbound_per_hour" integer DEFAULT 20,
    "voice_outbound_caller_id" "text",
    "voice_recording_enabled" boolean DEFAULT true,
    "voice_two_party_consent_states" "text"[] DEFAULT ARRAY['CA'::"text", 'CT'::"text", 'DE'::"text", 'FL'::"text", 'IL'::"text", 'MD'::"text", 'MA'::"text", 'MI'::"text", 'MT'::"text", 'NV'::"text", 'NH'::"text", 'OR'::"text", 'PA'::"text", 'VT'::"text", 'WA'::"text", 'WI'::"text"],
    "auto_tune_enabled" boolean DEFAULT false NOT NULL,
    "timezone" "text" DEFAULT 'America/Los_Angeles'::"text" NOT NULL,
    "autopilot_outreach_suppressed" boolean DEFAULT false NOT NULL,
    "feature_flags" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "organizations_autopilot_mode_check" CHECK (("autopilot_mode" = ANY (ARRAY['full'::"text", 'review_first'::"text", 'review_closers'::"text"]))),
    CONSTRAINT "organizations_subscription_status_check" CHECK (("subscription_status" = ANY (ARRAY['active'::"text", 'past_due'::"text", 'canceled'::"text", 'trialing'::"text"]))),
    CONSTRAINT "organizations_subscription_tier_check" CHECK (("subscription_tier" = ANY (ARRAY['trial'::"text", 'starter'::"text", 'professional'::"text", 'enterprise'::"text"])))
);


ALTER TABLE "public"."organizations" OWNER TO "postgres";


COMMENT ON COLUMN "public"."organizations"."autopilot_schedule" IS 'Per-day-of-week autopilot schedule with hours and mode overrides';



COMMENT ON COLUMN "public"."organizations"."auto_tune_enabled" IS 'When true, the discipline engine will live-swap agent_protocols.is_active. When false (default), it only logs ''protocol_proposed'' rows so admins can review.';



COMMENT ON COLUMN "public"."organizations"."feature_flags" IS 'Per-org dark-launch switchboard. All default OFF (absent key = false).';



CREATE TABLE IF NOT EXISTS "public"."patient_contracts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "clinical_case_id" "uuid" NOT NULL,
    "lead_id" "uuid",
    "treatment_closing_id" "uuid",
    "case_treatment_plan_id" "uuid",
    "template_id" "uuid",
    "template_version" integer NOT NULL,
    "template_snapshot" "jsonb" NOT NULL,
    "generated_content" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "context_snapshot" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "needs_manual_draft" boolean DEFAULT false NOT NULL,
    "reviewer_id" "uuid",
    "review_notes" "text",
    "reviewed_at" timestamp with time zone,
    "approved_at" timestamp with time zone,
    "share_token" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "share_token_expires_at" timestamp with time zone,
    "sent_at" timestamp with time zone,
    "sent_via" "text",
    "first_viewed_at" timestamp with time zone,
    "signed_at" timestamp with time zone,
    "signer_name" "text",
    "signer_ip" "inet",
    "signer_user_agent" "text",
    "signature_data_url" "text",
    "signature_type" "text",
    "consents_agreed" "jsonb" DEFAULT '[]'::"jsonb",
    "draft_pdf_storage_path" "text",
    "executed_pdf_storage_path" "text",
    "executed_pdf_sha256" "text",
    "contract_amount" numeric(10,2),
    "deposit_amount" numeric(10,2),
    "financing_type" "text",
    "financing_monthly_payment" numeric(10,2),
    "ai_model" "text",
    "ai_tokens_in" integer,
    "ai_tokens_out" integer,
    "ai_cost_cents" numeric(10,2),
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "patient_contracts_sent_via_check" CHECK (("sent_via" = ANY (ARRAY['email'::"text", 'sms'::"text", 'email+sms'::"text", 'portal_only'::"text"]))),
    CONSTRAINT "patient_contracts_signature_type_check" CHECK (("signature_type" = ANY (ARRAY['drawn'::"text", 'typed'::"text"]))),
    CONSTRAINT "patient_contracts_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'pending_review'::"text", 'changes_requested'::"text", 'approved'::"text", 'sent'::"text", 'viewed'::"text", 'signed'::"text", 'executed'::"text", 'declined'::"text", 'expired'::"text", 'voided'::"text"])))
);


ALTER TABLE "public"."patient_contracts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."patient_profiles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "lead_id" "uuid" NOT NULL,
    "personality_type" "text",
    "communication_style" "text",
    "decision_making_style" "text",
    "trust_level" "text" DEFAULT 'unknown'::"text",
    "emotional_state" "text" DEFAULT 'unknown'::"text",
    "anxiety_level" integer DEFAULT 0,
    "confidence_level" integer DEFAULT 5,
    "motivation_level" integer DEFAULT 5,
    "pain_points" "jsonb" DEFAULT '[]'::"jsonb",
    "desires" "jsonb" DEFAULT '[]'::"jsonb",
    "objections" "jsonb" DEFAULT '[]'::"jsonb",
    "price_sensitivity" integer DEFAULT 5,
    "urgency_perception" integer DEFAULT 5,
    "negotiation_style" "text",
    "influence_factors" "jsonb" DEFAULT '[]'::"jsonb",
    "rapport_score" integer DEFAULT 0,
    "personal_details" "jsonb" DEFAULT '{}'::"jsonb",
    "preferred_contact_time" "text",
    "preferred_channel" "text",
    "humor_receptivity" "text" DEFAULT 'unknown'::"text",
    "total_conversations_analyzed" integer DEFAULT 0,
    "key_moments" "jsonb" DEFAULT '[]'::"jsonb",
    "ai_summary" "text",
    "next_best_action" "text",
    "recommended_tone" "text",
    "topics_to_avoid" "jsonb" DEFAULT '[]'::"jsonb",
    "topics_to_emphasize" "jsonb" DEFAULT '[]'::"jsonb",
    "last_analyzed_at" timestamp with time zone,
    "analysis_version" integer DEFAULT 1,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "patient_profiles_anxiety_level_check" CHECK ((("anxiety_level" >= 0) AND ("anxiety_level" <= 10))),
    CONSTRAINT "patient_profiles_confidence_level_check" CHECK ((("confidence_level" >= 0) AND ("confidence_level" <= 10))),
    CONSTRAINT "patient_profiles_motivation_level_check" CHECK ((("motivation_level" >= 0) AND ("motivation_level" <= 10))),
    CONSTRAINT "patient_profiles_price_sensitivity_check" CHECK ((("price_sensitivity" >= 0) AND ("price_sensitivity" <= 10))),
    CONSTRAINT "patient_profiles_rapport_score_check" CHECK ((("rapport_score" >= 0) AND ("rapport_score" <= 10))),
    CONSTRAINT "patient_profiles_urgency_perception_check" CHECK ((("urgency_perception" >= 0) AND ("urgency_perception" <= 10)))
);


ALTER TABLE "public"."patient_profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."patients" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "ehr_patient_id" "text" NOT NULL,
    "ehr_source" "text" DEFAULT 'carestack'::"text" NOT NULL,
    "lead_id" "uuid",
    "match_method" "text",
    "match_confidence" numeric(3,2),
    "first_name" "text",
    "last_name" "text",
    "email" "text",
    "email_hash" "text",
    "phone_e164" "text",
    "phone_hash" "text",
    "dob" "date",
    "default_location_id" integer,
    "account_id" integer,
    "status" integer,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "patients_ehr_source_check" CHECK (("ehr_source" = ANY (ARRAY['carestack'::"text", 'open_dental'::"text", 'dentrix'::"text", 'eaglesoft'::"text", 'manual'::"text"]))),
    CONSTRAINT "patients_match_method_check" CHECK (("match_method" = ANY (ARRAY['email_hash'::"text", 'phone_hash'::"text", 'name_dob'::"text", 'manual'::"text", 'webhook_meta'::"text", 'unmatched'::"text"])))
);


ALTER TABLE "public"."patients" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pipeline_stages" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "description" "text",
    "color" "text" DEFAULT '#6B7280'::"text",
    "position" integer DEFAULT 0 NOT NULL,
    "is_default" boolean DEFAULT false,
    "is_won" boolean DEFAULT false,
    "is_lost" boolean DEFAULT false,
    "auto_actions" "jsonb" DEFAULT '[]'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."pipeline_stages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."practice_content_assets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "type" "text" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "content" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "media_urls" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "usage_count" integer DEFAULT 0 NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "practice_content_assets_type_check" CHECK (("type" = ANY (ARRAY['testimonial_video'::"text", 'before_after_photo'::"text", 'practice_info'::"text", 'appointment_details'::"text", 'financing_info'::"text", 'procedure_info'::"text"])))
);


ALTER TABLE "public"."practice_content_assets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."processed_webhook_events" (
    "organization_id" "uuid" NOT NULL,
    "source" "text" NOT NULL,
    "event_hash" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."processed_webhook_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reactivation_campaigns" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "campaign_id" "uuid",
    "created_by" "uuid",
    "name" "text" NOT NULL,
    "description" "text",
    "goal" "text" DEFAULT 're_engage'::"text" NOT NULL,
    "tone" "text" DEFAULT 'empathetic'::"text" NOT NULL,
    "ai_hooks" "jsonb" DEFAULT '[]'::"jsonb",
    "engagement_rules" "jsonb" DEFAULT '{"max_attempts": 5, "cooldown_days": 3, "stop_on_reply": true, "transition_to_live": true, "escalation_strategy": "vary_channel"}'::"jsonb",
    "channel" "text" DEFAULT 'multi'::"text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "total_uploaded" integer DEFAULT 0,
    "total_reactivated" integer DEFAULT 0,
    "total_responded" integer DEFAULT 0,
    "total_converted" integer DEFAULT 0,
    "last_upload_at" timestamp with time zone,
    "upload_count" integer DEFAULT 0,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "reactivation_campaigns_channel_check" CHECK (("channel" = ANY (ARRAY['sms'::"text", 'email'::"text", 'multi'::"text"]))),
    CONSTRAINT "reactivation_campaigns_goal_check" CHECK (("goal" = ANY (ARRAY['re_engage'::"text", 'win_back'::"text", 'upsell'::"text", 'referral_ask'::"text"]))),
    CONSTRAINT "reactivation_campaigns_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'active'::"text", 'paused'::"text", 'completed'::"text", 'archived'::"text"]))),
    CONSTRAINT "reactivation_campaigns_tone_check" CHECK (("tone" = ANY (ARRAY['empathetic'::"text", 'urgent'::"text", 'casual'::"text", 'professional'::"text"])))
);


ALTER TABLE "public"."reactivation_campaigns" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reactivation_offers" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "reactivation_campaign_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "type" "text" NOT NULL,
    "value" numeric(10,2),
    "expiry_date" timestamp with time zone,
    "usage_limit" integer,
    "times_used" integer DEFAULT 0,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "reactivation_offers_type_check" CHECK (("type" = ANY (ARRAY['percentage_off'::"text", 'dollar_off'::"text", 'free_addon'::"text", 'financing_special'::"text", 'limited_time'::"text"])))
);


ALTER TABLE "public"."reactivation_offers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reviews" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "source" "text" DEFAULT 'gbp'::"text" NOT NULL,
    "external_id" "text" NOT NULL,
    "external_url" "text",
    "reviewer_name" "text",
    "reviewer_avatar_url" "text",
    "star_rating" integer,
    "review_text" "text",
    "reviewed_at" timestamp with time zone,
    "sentiment" "text",
    "sentiment_score" numeric(4,2),
    "topics" "text"[],
    "sentiment_analyzed_at" timestamp with time zone,
    "draft_response" "text",
    "draft_response_at" timestamp with time zone,
    "draft_model" "text",
    "response_status" "text" DEFAULT 'unresponded'::"text" NOT NULL,
    "response_text" "text",
    "responded_at" timestamp with time zone,
    "responded_by" "uuid",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "reviews_response_status_check" CHECK (("response_status" = ANY (ARRAY['unresponded'::"text", 'drafted'::"text", 'approved'::"text", 'published'::"text", 'declined'::"text"]))),
    CONSTRAINT "reviews_sentiment_check" CHECK (("sentiment" = ANY (ARRAY['positive'::"text", 'neutral'::"text", 'negative'::"text"]))),
    CONSTRAINT "reviews_source_check" CHECK (("source" = ANY (ARRAY['gbp'::"text", 'yelp'::"text", 'healthgrades'::"text", 'manual'::"text"]))),
    CONSTRAINT "reviews_star_rating_check" CHECK ((("star_rating" >= 1) AND ("star_rating" <= 5)))
);


ALTER TABLE "public"."reviews" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."smart_lists" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "icon" "text" DEFAULT 'list-filter'::"text",
    "color" "text" DEFAULT '#6366F1'::"text" NOT NULL,
    "criteria" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "is_pinned" boolean DEFAULT false,
    "lead_count" integer DEFAULT 0,
    "last_refreshed_at" timestamp with time zone,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."smart_lists" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stripe_payments" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "stripe_event_id" "text" NOT NULL,
    "stripe_object_id" "text" NOT NULL,
    "stripe_object_type" "text" NOT NULL,
    "stripe_customer_id" "text",
    "stripe_account_id" "text",
    "amount_cents" integer NOT NULL,
    "amount" numeric(12,2) GENERATED ALWAYS AS ((("amount_cents")::numeric / (100)::numeric)) STORED,
    "currency" "text" DEFAULT 'USD'::"text" NOT NULL,
    "email" "text",
    "email_hash" "text",
    "phone" "text",
    "phone_hash" "text",
    "lead_id" "uuid",
    "patient_id" "uuid",
    "match_method" "text",
    "financing_partner" "text",
    "forwarded" boolean DEFAULT false,
    "forwarded_at" timestamp with time zone,
    "status" "text",
    "occurred_at" timestamp with time zone NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "raw_payload" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "stripe_payments_match_method_check" CHECK (("match_method" = ANY (ARRAY['email_hash'::"text", 'phone_hash'::"text", 'manual'::"text", 'webhook_meta'::"text", 'unmatched'::"text"]))),
    CONSTRAINT "stripe_payments_stripe_object_type_check" CHECK (("stripe_object_type" = ANY (ARRAY['payment_intent'::"text", 'invoice'::"text", 'subscription'::"text", 'charge'::"text", 'checkout_session'::"text"])))
);


ALTER TABLE "public"."stripe_payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stripe_webhook_events" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid",
    "stripe_event_id" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "status" "text",
    "error_message" "text",
    "raw_payload" "jsonb",
    "received_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "stripe_webhook_events_status_check" CHECK (("status" = ANY (ARRAY['received'::"text", 'processed'::"text", 'ignored'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."stripe_webhook_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tags" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "color" "text" DEFAULT '#6B7280'::"text" NOT NULL,
    "category" "text" DEFAULT 'custom'::"text" NOT NULL,
    "description" "text",
    "lead_count" integer DEFAULT 0,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "tags_category_check" CHECK (("category" = ANY (ARRAY['pipeline_stage'::"text", 'score'::"text", 'interest'::"text", 'behavior'::"text", 'custom'::"text"])))
);


ALTER TABLE "public"."tags" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."treatment_closings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lead_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "current_step" "text" DEFAULT 'treatment_plan_presented'::"text" NOT NULL,
    "steps_completed" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "contract_signed_at" timestamp with time zone,
    "contract_amount" numeric(10,2),
    "deposit_amount" numeric(10,2),
    "deposit_collected_at" timestamp with time zone,
    "non_refundable_acknowledged" boolean DEFAULT false NOT NULL,
    "financing_type" "text",
    "financing_funded_at" timestamp with time zone,
    "financing_monthly_payment" numeric(10,2),
    "consent_signed_at" timestamp with time zone,
    "consent_forms" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "preop_instructions_sent_at" timestamp with time zone,
    "preop_sent_via" "text",
    "postop_instructions_sent_at" timestamp with time zone,
    "surgery_date" "date",
    "surgery_time" time without time zone,
    "surgery_type" "text",
    "estimated_duration_hours" numeric(4,1),
    "records_confirmed_at" timestamp with time zone,
    "records_checklist" "jsonb" DEFAULT '{"ct_scan": false, "dental_records": false, "medical_records": false, "lab_work_ordered": false, "prescription_ready": false, "anesthesia_confirmed": false, "surgeon_availability": false, "surgical_guide_ready": false}'::"jsonb" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "treatment_closings_current_step_check" CHECK (("current_step" = ANY (ARRAY['treatment_plan_presented'::"text", 'contract_signed'::"text", 'financing_funded'::"text", 'consent_signed'::"text", 'preop_instructions_sent'::"text", 'surgery_scheduled'::"text", 'records_confirmed'::"text"]))),
    CONSTRAINT "treatment_closings_financing_type_check" CHECK (("financing_type" = ANY (ARRAY['loan'::"text", 'in_house'::"text", 'cash'::"text", 'insurance'::"text"]))),
    CONSTRAINT "treatment_closings_preop_sent_via_check" CHECK (("preop_sent_via" = ANY (ARRAY['sms'::"text", 'email'::"text", 'both'::"text"])))
);


ALTER TABLE "public"."treatment_closings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."treatment_outcomes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "lead_id" "uuid" NOT NULL,
    "treatment_closing_id" "uuid",
    "clinical_case_id" "uuid",
    "outcome" "text" NOT NULL,
    "satisfaction_score" integer,
    "follow_up_attended" boolean,
    "revision_required" boolean DEFAULT false NOT NULL,
    "final_revenue" numeric,
    "notes" "text",
    "recorded_by" "uuid",
    "occurred_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "treatment_outcomes_outcome_check" CHECK (("outcome" = ANY (ARRAY['success'::"text", 'complication'::"text", 'revision'::"text", 'failure'::"text"]))),
    CONSTRAINT "treatment_outcomes_satisfaction_score_check" CHECK ((("satisfaction_score" >= 1) AND ("satisfaction_score" <= 10)))
);


ALTER TABLE "public"."treatment_outcomes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."treatment_plans" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "ehr_treatment_plan_id" integer NOT NULL,
    "ehr_source" "text" DEFAULT 'carestack'::"text" NOT NULL,
    "name" "text",
    "status_id" integer NOT NULL,
    "duration" integer,
    "condition_ids" "text",
    "coordinator_id" integer,
    "total_patient_estimate" numeric(12,2),
    "total_insurance_estimate" numeric(12,2),
    "last_forwarded_status_id" integer,
    "last_forwarded_at" timestamp with time zone,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "ehr_last_updated_on" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."treatment_plans" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."treatment_procedures" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "patient_id" "uuid",
    "treatment_plan_id" "uuid",
    "ehr_procedure_id" integer NOT NULL,
    "ehr_source" "text" DEFAULT 'carestack'::"text" NOT NULL,
    "ehr_treatment_plan_id" integer,
    "ehr_treatment_plan_phase_id" integer,
    "ehr_appointment_id" integer,
    "ehr_provider_id" integer,
    "ehr_location_id" integer,
    "procedure_code_id" integer,
    "tooth" "text",
    "surfaces" "jsonb",
    "patient_estimate" numeric(12,2),
    "insurance_estimate" numeric(12,2),
    "status_id" integer,
    "proposed_date" timestamp with time zone,
    "date_of_service" timestamp with time zone,
    "is_deleted" boolean DEFAULT false,
    "last_forwarded_status_id" integer,
    "last_forwarded_at" timestamp with time zone,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "ehr_last_updated_on" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."treatment_procedures" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_profiles" (
    "id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "full_name" "text" NOT NULL,
    "email" "text" NOT NULL,
    "avatar_url" "text",
    "role" "text" DEFAULT 'member'::"text" NOT NULL,
    "is_active" boolean DEFAULT true,
    "last_seen_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "user_profiles_role_check" CHECK (("role" = ANY (ARRAY['agency_admin'::"text", 'owner'::"text", 'admin'::"text", 'manager'::"text", 'member'::"text"])))
);


ALTER TABLE "public"."user_profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."voice_calls" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "lead_id" "uuid" NOT NULL,
    "conversation_id" "uuid",
    "direction" "text" NOT NULL,
    "status" "text" DEFAULT 'initiated'::"text" NOT NULL,
    "retell_call_id" "text",
    "twilio_call_sid" "text",
    "from_number" "text" NOT NULL,
    "to_number" "text" NOT NULL,
    "duration_seconds" integer DEFAULT 0,
    "started_at" timestamp with time zone,
    "answered_at" timestamp with time zone,
    "ended_at" timestamp with time zone,
    "agent_type" "text",
    "ai_confidence_avg" numeric(4,3),
    "recording_url" "text",
    "recording_duration_seconds" integer,
    "transcript" "jsonb" DEFAULT '[]'::"jsonb",
    "transcript_summary" "text",
    "outcome" "text",
    "outcome_notes" "text",
    "voice_campaign_id" "uuid",
    "consent_verified" boolean DEFAULT false,
    "recording_disclosure_given" boolean DEFAULT false,
    "tcpa_compliant" boolean DEFAULT true,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "voice_calls_agent_type_check" CHECK (("agent_type" = ANY (ARRAY['setter'::"text", 'closer'::"text", 'none'::"text"]))),
    CONSTRAINT "voice_calls_direction_check" CHECK (("direction" = ANY (ARRAY['inbound'::"text", 'outbound'::"text"]))),
    CONSTRAINT "voice_calls_outcome_check" CHECK (("outcome" = ANY (ARRAY['appointment_booked'::"text", 'callback_requested'::"text", 'interested'::"text", 'not_interested'::"text", 'wrong_number'::"text", 'do_not_call'::"text", 'voicemail_left'::"text", 'no_answer'::"text", 'technical_failure'::"text", 'transferred'::"text", NULL::"text"]))),
    CONSTRAINT "voice_calls_status_check" CHECK (("status" = ANY (ARRAY['initiated'::"text", 'ringing'::"text", 'in_progress'::"text", 'completed'::"text", 'no_answer'::"text", 'busy'::"text", 'failed'::"text", 'voicemail'::"text", 'canceled'::"text"])))
);


ALTER TABLE "public"."voice_calls" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."voice_campaign_leads" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "voice_campaign_id" "uuid" NOT NULL,
    "lead_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'queued'::"text" NOT NULL,
    "attempts" integer DEFAULT 0,
    "last_attempt_at" timestamp with time zone,
    "last_call_id" "uuid",
    "outcome" "text",
    "priority" integer DEFAULT 0,
    "scheduled_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "voice_campaign_leads_status_check" CHECK (("status" = ANY (ARRAY['queued'::"text", 'calling'::"text", 'completed'::"text", 'skipped'::"text", 'failed'::"text", 'do_not_call'::"text"])))
);


ALTER TABLE "public"."voice_campaign_leads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."voice_campaigns" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "created_by" "uuid",
    "name" "text" NOT NULL,
    "description" "text",
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "smart_list_id" "uuid",
    "target_criteria" "jsonb" DEFAULT '{}'::"jsonb",
    "scheduled_start_at" timestamp with time zone,
    "scheduled_end_at" timestamp with time zone,
    "active_hours_start" integer DEFAULT 9,
    "active_hours_end" integer DEFAULT 18,
    "active_days" "text"[] DEFAULT ARRAY['monday'::"text", 'tuesday'::"text", 'wednesday'::"text", 'thursday'::"text", 'friday'::"text"],
    "timezone" "text" DEFAULT 'America/New_York'::"text",
    "max_attempts_per_lead" integer DEFAULT 3,
    "retry_delay_hours" integer DEFAULT 24,
    "concurrent_calls" integer DEFAULT 1,
    "calls_per_hour" integer DEFAULT 20,
    "agent_type" "text" DEFAULT 'setter'::"text",
    "custom_greeting" "text",
    "custom_voicemail" "text",
    "total_leads" integer DEFAULT 0,
    "total_called" integer DEFAULT 0,
    "total_connected" integer DEFAULT 0,
    "total_appointments" integer DEFAULT 0,
    "total_voicemails" integer DEFAULT 0,
    "total_no_answer" integer DEFAULT 0,
    "total_do_not_call" integer DEFAULT 0,
    "avg_call_duration_seconds" integer DEFAULT 0,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "voice_campaigns_agent_type_check" CHECK (("agent_type" = ANY (ARRAY['setter'::"text", 'closer'::"text"]))),
    CONSTRAINT "voice_campaigns_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'scheduled'::"text", 'active'::"text", 'paused'::"text", 'completed'::"text", 'archived'::"text"])))
);


ALTER TABLE "public"."voice_campaigns" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."windsor_sync_state" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "last_synced_date" "date",
    "last_run_at" timestamp with time zone,
    "last_run_status" "text",
    "last_run_rows" integer,
    "last_run_error" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "windsor_sync_state_last_run_status_check" CHECK (("last_run_status" = ANY (ARRAY['success'::"text", 'partial'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."windsor_sync_state" OWNER TO "postgres";


ALTER TABLE ONLY "public"."a2p_status"
    ADD CONSTRAINT "a2p_status_campaign_sid_key" UNIQUE ("campaign_sid");



ALTER TABLE ONLY "public"."a2p_status"
    ADD CONSTRAINT "a2p_status_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ad_metrics_daily"
    ADD CONSTRAINT "ad_metrics_daily_organization_id_channel_account_id_campaig_key" UNIQUE ("organization_id", "channel", "account_id", "campaign_id", "metric_date");



ALTER TABLE ONLY "public"."ad_metrics_daily"
    ADD CONSTRAINT "ad_metrics_daily_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ad_metrics_sync_state"
    ADD CONSTRAINT "ad_metrics_sync_state_pkey" PRIMARY KEY ("organization_id", "channel");



ALTER TABLE ONLY "public"."ad_spend_daily"
    ADD CONSTRAINT "ad_spend_daily_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agency_active_org"
    ADD CONSTRAINT "agency_active_org_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."agency_settings"
    ADD CONSTRAINT "agency_settings_key_key" UNIQUE ("key");



ALTER TABLE ONLY "public"."agency_settings"
    ADD CONSTRAINT "agency_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agent_handoffs"
    ADD CONSTRAINT "agent_handoffs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agent_kpi_targets"
    ADD CONSTRAINT "agent_kpi_targets_agent_id_kpi_name_key" UNIQUE ("agent_id", "kpi_name");



ALTER TABLE ONLY "public"."agent_kpi_targets"
    ADD CONSTRAINT "agent_kpi_targets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agent_lead_caps"
    ADD CONSTRAINT "agent_lead_caps_pkey" PRIMARY KEY ("agent_id");



ALTER TABLE ONLY "public"."agent_performance_daily"
    ADD CONSTRAINT "agent_performance_daily_pkey" PRIMARY KEY ("agent_id", "date");



ALTER TABLE ONLY "public"."agent_performance_reviews"
    ADD CONSTRAINT "agent_performance_reviews_agent_id_period_start_period_end_key" UNIQUE ("agent_id", "period_start", "period_end");



ALTER TABLE ONLY "public"."agent_performance_reviews"
    ADD CONSTRAINT "agent_performance_reviews_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agent_protocol_changes"
    ADD CONSTRAINT "agent_protocol_changes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agent_protocols"
    ADD CONSTRAINT "agent_protocols_agent_id_version_key" UNIQUE ("agent_id", "version");



ALTER TABLE ONLY "public"."agent_protocols"
    ADD CONSTRAINT "agent_protocols_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agent_status_current"
    ADD CONSTRAINT "agent_status_current_pkey" PRIMARY KEY ("agent_id");



ALTER TABLE ONLY "public"."ai_agents"
    ADD CONSTRAINT "ai_agents_organization_id_role_key" UNIQUE ("organization_id", "role");



ALTER TABLE ONLY "public"."ai_agents"
    ADD CONSTRAINT "ai_agents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_conversation_ratings"
    ADD CONSTRAINT "ai_conversation_ratings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_interactions"
    ADD CONSTRAINT "ai_interactions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_knowledge_articles"
    ADD CONSTRAINT "ai_knowledge_articles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_memories"
    ADD CONSTRAINT "ai_memories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_roleplay_sessions"
    ADD CONSTRAINT "ai_roleplay_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_test_conversations"
    ADD CONSTRAINT "ai_test_conversations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_training_examples"
    ADD CONSTRAINT "ai_training_examples_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_usage"
    ADD CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."appointment_reminders"
    ADD CONSTRAINT "appointment_reminders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."appointments"
    ADD CONSTRAINT "appointments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."booking_settings"
    ADD CONSTRAINT "booking_settings_organization_id_key" UNIQUE ("organization_id");



ALTER TABLE ONLY "public"."booking_settings"
    ADD CONSTRAINT "booking_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."brex_sync_state"
    ADD CONSTRAINT "brex_sync_state_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."campaign_enrollments"
    ADD CONSTRAINT "campaign_enrollments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."campaign_steps"
    ADD CONSTRAINT "campaign_steps_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."campaigns"
    ADD CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."case_diagnosis"
    ADD CONSTRAINT "case_diagnosis_case_id_key" UNIQUE ("case_id");



ALTER TABLE ONLY "public"."case_diagnosis"
    ADD CONSTRAINT "case_diagnosis_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."case_files"
    ADD CONSTRAINT "case_files_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."case_treatment_plans"
    ADD CONSTRAINT "case_treatment_plans_case_id_key" UNIQUE ("case_id");



ALTER TABLE ONLY "public"."case_treatment_plans"
    ADD CONSTRAINT "case_treatment_plans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."clinical_cases"
    ADD CONSTRAINT "clinical_cases_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."competitors"
    ADD CONSTRAINT "competitors_organization_id_name_key" UNIQUE ("organization_id", "name");



ALTER TABLE ONLY "public"."competitors"
    ADD CONSTRAINT "competitors_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."connector_configs"
    ADD CONSTRAINT "connector_configs_organization_id_connector_type_key" UNIQUE ("organization_id", "connector_type");



ALTER TABLE ONLY "public"."connector_configs"
    ADD CONSTRAINT "connector_configs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."connector_events"
    ADD CONSTRAINT "connector_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."consent_capture_tokens"
    ADD CONSTRAINT "consent_capture_tokens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."consent_capture_tokens"
    ADD CONSTRAINT "consent_capture_tokens_token_key" UNIQUE ("token");



ALTER TABLE ONLY "public"."consent_log"
    ADD CONSTRAINT "consent_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contract_events"
    ADD CONSTRAINT "contract_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contract_templates"
    ADD CONSTRAINT "contract_templates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."conversation_analyses"
    ADD CONSTRAINT "conversation_analyses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."conversation_technique_summaries"
    ADD CONSTRAINT "conversation_technique_summaries_conversation_id_key" UNIQUE ("conversation_id");



ALTER TABLE ONLY "public"."conversation_technique_summaries"
    ADD CONSTRAINT "conversation_technique_summaries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cron_runs"
    ADD CONSTRAINT "cron_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cross_channel_deliveries"
    ADD CONSTRAINT "cross_channel_deliveries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."daily_analytics"
    ADD CONSTRAINT "daily_analytics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ehr_sync_state"
    ADD CONSTRAINT "ehr_sync_state_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."escalations"
    ADD CONSTRAINT "escalations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."expense_line_items"
    ADD CONSTRAINT "expense_line_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."financing_applications"
    ADD CONSTRAINT "financing_applications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."financing_applications"
    ADD CONSTRAINT "financing_applications_share_token_key" UNIQUE ("share_token");



ALTER TABLE ONLY "public"."financing_lender_configs"
    ADD CONSTRAINT "financing_lender_configs_organization_id_lender_slug_key" UNIQUE ("organization_id", "lender_slug");



ALTER TABLE ONLY "public"."financing_lender_configs"
    ADD CONSTRAINT "financing_lender_configs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."financing_submissions"
    ADD CONSTRAINT "financing_submissions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."growth_studio_outbox"
    ADD CONSTRAINT "growth_studio_outbox_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."growth_studio_webhook_config"
    ADD CONSTRAINT "growth_studio_webhook_config_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."hipaa_audit_log"
    ADD CONSTRAINT "hipaa_audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lead_activities"
    ADD CONSTRAINT "lead_activities_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lead_competitor_mentions"
    ADD CONSTRAINT "lead_competitor_mentions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lead_engagement_assessments"
    ADD CONSTRAINT "lead_engagement_assessments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lead_enrichment"
    ADD CONSTRAINT "lead_enrichment_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lead_nurture_state"
    ADD CONSTRAINT "lead_nurture_state_pkey" PRIMARY KEY ("lead_id");



ALTER TABLE ONLY "public"."lead_sources"
    ADD CONSTRAINT "lead_sources_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lead_tags"
    ADD CONSTRAINT "lead_tags_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."leads"
    ADD CONSTRAINT "leads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."mass_send_idempotency"
    ADD CONSTRAINT "mass_send_idempotency_pkey" PRIMARY KEY ("organization_id", "idempotency_key");



ALTER TABLE ONLY "public"."message_technique_tracking"
    ADD CONSTRAINT "message_technique_tracking_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."oauth_states"
    ADD CONSTRAINT "oauth_states_pkey" PRIMARY KEY ("state");



ALTER TABLE ONLY "public"."org_goals"
    ADD CONSTRAINT "org_goals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."patient_contracts"
    ADD CONSTRAINT "patient_contracts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."patient_profiles"
    ADD CONSTRAINT "patient_profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."patients"
    ADD CONSTRAINT "patients_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pipeline_stages"
    ADD CONSTRAINT "pipeline_stages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."practice_content_assets"
    ADD CONSTRAINT "practice_content_assets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."processed_webhook_events"
    ADD CONSTRAINT "processed_webhook_events_pkey" PRIMARY KEY ("organization_id", "source", "event_hash");



ALTER TABLE ONLY "public"."reactivation_campaigns"
    ADD CONSTRAINT "reactivation_campaigns_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reactivation_offers"
    ADD CONSTRAINT "reactivation_offers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reviews"
    ADD CONSTRAINT "reviews_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."smart_lists"
    ADD CONSTRAINT "smart_lists_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stripe_payments"
    ADD CONSTRAINT "stripe_payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stripe_webhook_events"
    ADD CONSTRAINT "stripe_webhook_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tags"
    ADD CONSTRAINT "tags_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."treatment_closings"
    ADD CONSTRAINT "treatment_closings_lead_id_key" UNIQUE ("lead_id");



ALTER TABLE ONLY "public"."treatment_closings"
    ADD CONSTRAINT "treatment_closings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."treatment_outcomes"
    ADD CONSTRAINT "treatment_outcomes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."treatment_plans"
    ADD CONSTRAINT "treatment_plans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."treatment_procedures"
    ADD CONSTRAINT "treatment_procedures_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."patient_profiles"
    ADD CONSTRAINT "unique_lead_profile" UNIQUE ("lead_id");



ALTER TABLE ONLY "public"."user_profiles"
    ADD CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."voice_calls"
    ADD CONSTRAINT "voice_calls_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."voice_calls"
    ADD CONSTRAINT "voice_calls_retell_call_id_key" UNIQUE ("retell_call_id");



ALTER TABLE ONLY "public"."voice_campaign_leads"
    ADD CONSTRAINT "voice_campaign_leads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."voice_campaign_leads"
    ADD CONSTRAINT "voice_campaign_leads_voice_campaign_id_lead_id_key" UNIQUE ("voice_campaign_id", "lead_id");



ALTER TABLE ONLY "public"."voice_campaigns"
    ADD CONSTRAINT "voice_campaigns_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."windsor_sync_state"
    ADD CONSTRAINT "windsor_sync_state_pkey" PRIMARY KEY ("id");



CREATE INDEX "idx_ad_metrics_org_channel_date" ON "public"."ad_metrics_daily" USING "btree" ("organization_id", "channel", "metric_date" DESC);



CREATE INDEX "idx_ad_metrics_org_date" ON "public"."ad_metrics_daily" USING "btree" ("organization_id", "metric_date" DESC);



CREATE INDEX "idx_ad_spend_daily_org_campaign" ON "public"."ad_spend_daily" USING "btree" ("organization_id", "campaign_name") WHERE ("campaign_name" IS NOT NULL);



CREATE INDEX "idx_ad_spend_daily_org_date" ON "public"."ad_spend_daily" USING "btree" ("organization_id", "date" DESC);



CREATE INDEX "idx_ad_spend_daily_org_platform_date" ON "public"."ad_spend_daily" USING "btree" ("organization_id", "platform", "date" DESC);



CREATE UNIQUE INDEX "idx_ad_spend_daily_unique" ON "public"."ad_spend_daily" USING "btree" ("organization_id", "date", "platform", COALESCE("campaign_id", ''::"text"), COALESCE("ad_group_id", ''::"text"));



CREATE INDEX "idx_agency_active_org_org" ON "public"."agency_active_org" USING "btree" ("active_org_id");



CREATE INDEX "idx_agent_handoffs_conversation" ON "public"."agent_handoffs" USING "btree" ("conversation_id");



CREATE INDEX "idx_agent_handoffs_lead" ON "public"."agent_handoffs" USING "btree" ("lead_id");



CREATE INDEX "idx_agent_handoffs_org_created" ON "public"."agent_handoffs" USING "btree" ("organization_id", "created_at" DESC);



CREATE INDEX "idx_agent_kpi_targets_agent" ON "public"."agent_kpi_targets" USING "btree" ("agent_id");



CREATE INDEX "idx_agent_lead_caps_org" ON "public"."agent_lead_caps" USING "btree" ("organization_id");



CREATE INDEX "idx_agent_perf_daily_org_date" ON "public"."agent_performance_daily" USING "btree" ("organization_id", "date" DESC);



CREATE INDEX "idx_agent_perf_reviews_agent_period" ON "public"."agent_performance_reviews" USING "btree" ("agent_id", "period_end" DESC);



CREATE INDEX "idx_agent_perf_reviews_org_grade" ON "public"."agent_performance_reviews" USING "btree" ("organization_id", "overall_grade", "period_end" DESC);



CREATE INDEX "idx_agent_protocol_changes_agent" ON "public"."agent_protocol_changes" USING "btree" ("agent_id", "created_at" DESC);



CREATE INDEX "idx_agent_protocol_changes_org_type" ON "public"."agent_protocol_changes" USING "btree" ("organization_id", "change_type", "created_at" DESC);



CREATE INDEX "idx_agent_protocols_agent_version" ON "public"."agent_protocols" USING "btree" ("agent_id", "version" DESC);



CREATE UNIQUE INDEX "idx_agent_protocols_one_active" ON "public"."agent_protocols" USING "btree" ("agent_id") WHERE ("is_active" = true);



CREATE INDEX "idx_agent_status_org_status" ON "public"."agent_status_current" USING "btree" ("organization_id", "status");



CREATE INDEX "idx_ai_agents_org" ON "public"."ai_agents" USING "btree" ("organization_id");



CREATE INDEX "idx_ai_agents_org_role_active" ON "public"."ai_agents" USING "btree" ("organization_id", "role") WHERE ("is_active" = true);



CREATE INDEX "idx_ai_interactions_lead" ON "public"."ai_interactions" USING "btree" ("lead_id");



CREATE INDEX "idx_ai_interactions_org" ON "public"."ai_interactions" USING "btree" ("organization_id", "created_at" DESC);



CREATE INDEX "idx_ai_interactions_type" ON "public"."ai_interactions" USING "btree" ("organization_id", "interaction_type");



CREATE INDEX "idx_ai_knowledge_org" ON "public"."ai_knowledge_articles" USING "btree" ("organization_id");



CREATE INDEX "idx_ai_knowledge_tags" ON "public"."ai_knowledge_articles" USING "gin" ("tags");



CREATE INDEX "idx_ai_memories_active" ON "public"."ai_memories" USING "btree" ("organization_id", "is_enabled", "priority" DESC);



CREATE INDEX "idx_ai_memories_org" ON "public"."ai_memories" USING "btree" ("organization_id");



CREATE UNIQUE INDEX "idx_ai_ratings_conv_user" ON "public"."ai_conversation_ratings" USING "btree" ("conversation_id", "rated_by");



CREATE INDEX "idx_ai_ratings_flagged" ON "public"."ai_conversation_ratings" USING "btree" ("organization_id", "flagged") WHERE ("flagged" = true);



CREATE INDEX "idx_ai_ratings_org" ON "public"."ai_conversation_ratings" USING "btree" ("organization_id", "created_at" DESC);



CREATE INDEX "idx_ai_test_convos_org" ON "public"."ai_test_conversations" USING "btree" ("organization_id", "created_at" DESC);



CREATE INDEX "idx_ai_usage_feature" ON "public"."ai_usage" USING "btree" ("organization_id", "feature", "occurred_at" DESC);



CREATE INDEX "idx_ai_usage_lead_day" ON "public"."ai_usage" USING "btree" ("lead_id", "occurred_at" DESC) WHERE ("lead_id" IS NOT NULL);



CREATE INDEX "idx_ai_usage_org_occurred" ON "public"."ai_usage" USING "btree" ("organization_id", "occurred_at" DESC);



CREATE INDEX "idx_appointment_reminders_appointment" ON "public"."appointment_reminders" USING "btree" ("appointment_id");



CREATE INDEX "idx_appointment_reminders_lead" ON "public"."appointment_reminders" USING "btree" ("lead_id");



CREATE INDEX "idx_appointment_reminders_org" ON "public"."appointment_reminders" USING "btree" ("organization_id");



CREATE INDEX "idx_appointment_reminders_pending" ON "public"."appointment_reminders" USING "btree" ("status", "scheduled_for") WHERE ("status" = 'pending'::"text");



CREATE INDEX "idx_appointment_reminders_status" ON "public"."appointment_reminders" USING "btree" ("status", "reminder_type");



CREATE UNIQUE INDEX "idx_appointments_external_unique" ON "public"."appointments" USING "btree" ("organization_id", "external_source", "external_id") WHERE ("external_id" IS NOT NULL);



CREATE INDEX "idx_appointments_lead" ON "public"."appointments" USING "btree" ("lead_id");



CREATE UNIQUE INDEX "idx_appointments_no_double_book" ON "public"."appointments" USING "btree" ("organization_id", "scheduled_at") WHERE ("status" <> 'canceled'::"text");



CREATE INDEX "idx_appointments_org" ON "public"."appointments" USING "btree" ("organization_id", "scheduled_at");



CREATE INDEX "idx_appointments_org_status" ON "public"."appointments" USING "btree" ("organization_id", "status");



CREATE INDEX "idx_appointments_reminder_due" ON "public"."appointments" USING "btree" ("organization_id", "status", "scheduled_at") WHERE ("status" = ANY (ARRAY['scheduled'::"text", 'confirmed'::"text"]));



CREATE UNIQUE INDEX "idx_brex_sync_state_org" ON "public"."brex_sync_state" USING "btree" ("organization_id");



CREATE INDEX "idx_campaign_enrollments_lead" ON "public"."campaign_enrollments" USING "btree" ("lead_id");



CREATE INDEX "idx_campaign_enrollments_next" ON "public"."campaign_enrollments" USING "btree" ("next_step_at") WHERE ("status" = 'active'::"text");



CREATE UNIQUE INDEX "idx_campaign_enrollments_unique" ON "public"."campaign_enrollments" USING "btree" ("campaign_id", "lead_id");



CREATE INDEX "idx_campaign_steps_campaign" ON "public"."campaign_steps" USING "btree" ("campaign_id", "step_number");



CREATE INDEX "idx_campaigns_org" ON "public"."campaigns" USING "btree" ("organization_id", "status");



CREATE INDEX "idx_campaigns_smart_list" ON "public"."campaigns" USING "btree" ("smart_list_id") WHERE ("smart_list_id" IS NOT NULL);



CREATE INDEX "idx_case_files_case" ON "public"."case_files" USING "btree" ("case_id");



CREATE INDEX "idx_clinical_cases_assigned" ON "public"."clinical_cases" USING "btree" ("assigned_doctor_id") WHERE ("assigned_doctor_id" IS NOT NULL);



CREATE INDEX "idx_clinical_cases_lead" ON "public"."clinical_cases" USING "btree" ("lead_id") WHERE ("lead_id" IS NOT NULL);



CREATE INDEX "idx_clinical_cases_org_status" ON "public"."clinical_cases" USING "btree" ("organization_id", "status");



CREATE INDEX "idx_clinical_cases_share_token" ON "public"."clinical_cases" USING "btree" ("share_token");



CREATE INDEX "idx_connector_configs_org" ON "public"."connector_configs" USING "btree" ("organization_id");



CREATE INDEX "idx_connector_events_dispatched" ON "public"."connector_events" USING "btree" ("dispatched_at" DESC);



CREATE INDEX "idx_connector_events_lead" ON "public"."connector_events" USING "btree" ("lead_id");



CREATE INDEX "idx_connector_events_org_type" ON "public"."connector_events" USING "btree" ("organization_id", "connector_type");



CREATE INDEX "idx_consent_log_lead" ON "public"."consent_log" USING "btree" ("lead_id", "created_at" DESC);



CREATE INDEX "idx_consent_log_org" ON "public"."consent_log" USING "btree" ("organization_id", "created_at" DESC);



CREATE INDEX "idx_consent_log_org_channel" ON "public"."consent_log" USING "btree" ("organization_id", "channel", "created_at" DESC);



CREATE INDEX "idx_consent_tokens_lead" ON "public"."consent_capture_tokens" USING "btree" ("lead_id", "created_at" DESC);



CREATE INDEX "idx_content_assets_org_tags" ON "public"."practice_content_assets" USING "gin" ("tags") WHERE ("is_active" = true);



CREATE INDEX "idx_content_assets_org_type" ON "public"."practice_content_assets" USING "btree" ("organization_id", "type") WHERE ("is_active" = true);



CREATE INDEX "idx_contract_events_contract" ON "public"."contract_events" USING "btree" ("contract_id", "created_at" DESC);



CREATE INDEX "idx_contract_events_org" ON "public"."contract_events" USING "btree" ("organization_id", "created_at" DESC);



CREATE UNIQUE INDEX "idx_contract_templates_active" ON "public"."contract_templates" USING "btree" ("organization_id", "slug") WHERE ("status" = 'published'::"text");



CREATE INDEX "idx_contract_templates_org" ON "public"."contract_templates" USING "btree" ("organization_id");



CREATE INDEX "idx_conv_analyses_conv" ON "public"."conversation_analyses" USING "btree" ("conversation_id");



CREATE INDEX "idx_conv_analyses_lead" ON "public"."conversation_analyses" USING "btree" ("lead_id");



CREATE INDEX "idx_conv_analyses_org" ON "public"."conversation_analyses" USING "btree" ("organization_id", "analyzed_at" DESC);



CREATE INDEX "idx_conversations_channel" ON "public"."conversations" USING "btree" ("organization_id", "channel");



CREATE INDEX "idx_conversations_lead" ON "public"."conversations" USING "btree" ("lead_id");



CREATE INDEX "idx_conversations_org" ON "public"."conversations" USING "btree" ("organization_id", "last_message_at" DESC);



CREATE INDEX "idx_cron_runs_cron_ran_at" ON "public"."cron_runs" USING "btree" ("cron", "ran_at" DESC);



CREATE INDEX "idx_cross_channel_conversation" ON "public"."cross_channel_deliveries" USING "btree" ("conversation_id");



CREATE INDEX "idx_cross_channel_lead" ON "public"."cross_channel_deliveries" USING "btree" ("lead_id");



CREATE INDEX "idx_cross_channel_org_date" ON "public"."cross_channel_deliveries" USING "btree" ("organization_id", "created_at" DESC);



CREATE INDEX "idx_cts_lead" ON "public"."conversation_technique_summaries" USING "btree" ("lead_id");



CREATE INDEX "idx_cts_org" ON "public"."conversation_technique_summaries" USING "btree" ("organization_id");



CREATE UNIQUE INDEX "idx_daily_analytics_org_date" ON "public"."daily_analytics" USING "btree" ("organization_id", "date");



CREATE UNIQUE INDEX "idx_ehr_sync_state_unique" ON "public"."ehr_sync_state" USING "btree" ("organization_id", "ehr_source", "resource");



CREATE INDEX "idx_enrichment_lead" ON "public"."lead_enrichment" USING "btree" ("lead_id", "enrichment_type");



CREATE INDEX "idx_enrichment_org" ON "public"."lead_enrichment" USING "btree" ("organization_id", "enrichment_type");



CREATE INDEX "idx_enrichment_org_status" ON "public"."lead_enrichment" USING "btree" ("organization_id", "status") WHERE ("status" = 'pending'::"text");



CREATE INDEX "idx_escalations_lead" ON "public"."escalations" USING "btree" ("lead_id");



CREATE INDEX "idx_escalations_org_status" ON "public"."escalations" USING "btree" ("organization_id", "status");



CREATE INDEX "idx_events_capi_pending" ON "public"."events" USING "btree" ("occurred_at") WHERE ("capi_status" = 'pending'::"text");



CREATE INDEX "idx_events_gads_pending" ON "public"."events" USING "btree" ("occurred_at") WHERE ("gads_status" = 'pending'::"text");



CREATE INDEX "idx_events_lead" ON "public"."events" USING "btree" ("lead_id", "occurred_at" DESC) WHERE ("lead_id" IS NOT NULL);



CREATE INDEX "idx_events_org_occurred" ON "public"."events" USING "btree" ("organization_id", "occurred_at" DESC);



CREATE INDEX "idx_events_org_type" ON "public"."events" USING "btree" ("organization_id", "event_type", "occurred_at" DESC);



CREATE INDEX "idx_expense_line_items_org_category" ON "public"."expense_line_items" USING "btree" ("organization_id", "category", "posted_at" DESC);



CREATE INDEX "idx_expense_line_items_org_posted" ON "public"."expense_line_items" USING "btree" ("organization_id", "posted_at" DESC);



CREATE UNIQUE INDEX "idx_expense_line_items_unique" ON "public"."expense_line_items" USING "btree" ("organization_id", "source", "external_id");



CREATE INDEX "idx_expense_line_items_vendor" ON "public"."expense_line_items" USING "btree" ("organization_id", "vendor_normalized") WHERE ("vendor_normalized" IS NOT NULL);



CREATE INDEX "idx_financing_applications_org_lead" ON "public"."financing_applications" USING "btree" ("organization_id", "lead_id");



CREATE UNIQUE INDEX "idx_financing_applications_share_token" ON "public"."financing_applications" USING "btree" ("share_token") WHERE ("share_token" IS NOT NULL);



CREATE INDEX "idx_financing_submissions_app_step" ON "public"."financing_submissions" USING "btree" ("application_id", "waterfall_step");



CREATE INDEX "idx_financing_submissions_org_lead" ON "public"."financing_submissions" USING "btree" ("organization_id", "lead_id");



CREATE INDEX "idx_gs_outbox_request_id" ON "public"."growth_studio_outbox" USING "btree" ("request_id");



CREATE INDEX "idx_gs_outbox_status" ON "public"."growth_studio_outbox" USING "btree" ("status");



CREATE INDEX "idx_hipaa_audit_org" ON "public"."hipaa_audit_log" USING "btree" ("organization_id", "created_at" DESC);



CREATE INDEX "idx_hipaa_audit_severity" ON "public"."hipaa_audit_log" USING "btree" ("organization_id", "severity");



CREATE UNIQUE INDEX "idx_invoices_ehr_unique" ON "public"."invoices" USING "btree" ("organization_id", "ehr_source", "ehr_invoice_id");



CREATE INDEX "idx_invoices_org_paid" ON "public"."invoices" USING "btree" ("organization_id", "payment_date" DESC) WHERE (("forwarded" = false) AND ("is_deleted" = false));



CREATE INDEX "idx_invoices_patient" ON "public"."invoices" USING "btree" ("patient_id", "payment_date" DESC);



CREATE INDEX "idx_lea_conv" ON "public"."lead_engagement_assessments" USING "btree" ("conversation_id");



CREATE INDEX "idx_lea_lead" ON "public"."lead_engagement_assessments" USING "btree" ("lead_id");



CREATE INDEX "idx_lea_org" ON "public"."lead_engagement_assessments" USING "btree" ("organization_id", "created_at" DESC);



CREATE INDEX "idx_lead_activities_lead" ON "public"."lead_activities" USING "btree" ("lead_id", "created_at" DESC);



CREATE INDEX "idx_lead_activities_org" ON "public"."lead_activities" USING "btree" ("organization_id", "created_at" DESC);



CREATE INDEX "idx_lead_competitor_mentions_lead" ON "public"."lead_competitor_mentions" USING "btree" ("lead_id", "detected_at" DESC);



CREATE INDEX "idx_lead_sources_org" ON "public"."lead_sources" USING "btree" ("organization_id");



CREATE INDEX "idx_lead_tags_lead" ON "public"."lead_tags" USING "btree" ("lead_id");



CREATE INDEX "idx_lead_tags_org" ON "public"."lead_tags" USING "btree" ("organization_id");



CREATE INDEX "idx_lead_tags_tag" ON "public"."lead_tags" USING "btree" ("tag_id");



CREATE UNIQUE INDEX "idx_lead_tags_unique" ON "public"."lead_tags" USING "btree" ("lead_id", "tag_id");



CREATE INDEX "idx_leads_created" ON "public"."leads" USING "btree" ("organization_id", "created_at" DESC);



CREATE INDEX "idx_leads_email" ON "public"."leads" USING "btree" ("organization_id", "email");



CREATE INDEX "idx_leads_email_consent" ON "public"."leads" USING "btree" ("organization_id", "email_consent") WHERE (("email_consent" = true) AND ("email_opt_out" = false));



CREATE UNIQUE INDEX "idx_leads_email_hash_uniq" ON "public"."leads" USING "btree" ("organization_id", "email_hash") WHERE ("email_hash" IS NOT NULL);



CREATE INDEX "idx_leads_enrichment_status" ON "public"."leads" USING "btree" ("organization_id", "enrichment_status") WHERE ("enrichment_status" = ANY (ARRAY['pending'::"text", 'partial'::"text"]));



CREATE INDEX "idx_leads_external_ref" ON "public"."leads" USING "btree" ("external_ref");



CREATE INDEX "idx_leads_financial_tier" ON "public"."leads" USING "btree" ("organization_id", "financial_qualification_tier") WHERE ("financial_qualification_tier" = ANY (ARRAY['tier_a'::"text", 'tier_b'::"text"]));



CREATE INDEX "idx_leads_financing_readiness" ON "public"."leads" USING "btree" ("organization_id", "financing_readiness_score" DESC) WHERE ("financing_readiness_score" > 50);



CREATE INDEX "idx_leads_org" ON "public"."leads" USING "btree" ("organization_id");



CREATE INDEX "idx_leads_org_assigned" ON "public"."leads" USING "btree" ("organization_id", "assigned_to");



CREATE INDEX "idx_leads_org_created" ON "public"."leads" USING "btree" ("organization_id", "created_at");



CREATE INDEX "idx_leads_org_last_contacted" ON "public"."leads" USING "btree" ("organization_id", "last_contacted_at") WHERE ("status" <> ALL (ARRAY['completed'::"text", 'lost'::"text", 'disqualified'::"text", 'dormant'::"text"]));



CREATE INDEX "idx_leads_org_qualification" ON "public"."leads" USING "btree" ("organization_id", "ai_qualification");



CREATE INDEX "idx_leads_org_score" ON "public"."leads" USING "btree" ("organization_id", "ai_score" DESC);



CREATE INDEX "idx_leads_org_stage" ON "public"."leads" USING "btree" ("organization_id", "stage_id");



CREATE INDEX "idx_leads_org_status" ON "public"."leads" USING "btree" ("organization_id", "status");



CREATE INDEX "idx_leads_phone" ON "public"."leads" USING "btree" ("organization_id", "phone");



CREATE INDEX "idx_leads_phone_hash" ON "public"."leads" USING "btree" ("organization_id", "phone_hash") WHERE ("phone_hash" IS NOT NULL);



CREATE INDEX "idx_leads_sms_consent" ON "public"."leads" USING "btree" ("organization_id", "sms_consent") WHERE (("sms_consent" = true) AND ("sms_opt_out" = false));



CREATE INDEX "idx_leads_sms_consent_unknown" ON "public"."leads" USING "btree" ("organization_id") WHERE ("sms_consent_status" = 'unknown'::"text");



CREATE INDEX "idx_leads_source" ON "public"."leads" USING "btree" ("organization_id", "source_id");



CREATE INDEX "idx_mass_send_idem_created" ON "public"."mass_send_idempotency" USING "btree" ("created_at");



CREATE INDEX "idx_messages_agent_created" ON "public"."messages" USING "btree" ("agent_id", "created_at" DESC) WHERE ("agent_id" IS NOT NULL);



CREATE INDEX "idx_messages_conversation" ON "public"."messages" USING "btree" ("conversation_id", "created_at");



CREATE INDEX "idx_messages_external" ON "public"."messages" USING "btree" ("external_id");



CREATE INDEX "idx_messages_lead" ON "public"."messages" USING "btree" ("lead_id", "created_at" DESC);



CREATE INDEX "idx_messages_org" ON "public"."messages" USING "btree" ("organization_id", "created_at" DESC);



CREATE INDEX "idx_messages_org_created" ON "public"."messages" USING "btree" ("organization_id", "created_at");



CREATE INDEX "idx_mtt_conv" ON "public"."message_technique_tracking" USING "btree" ("conversation_id");



CREATE INDEX "idx_mtt_lead" ON "public"."message_technique_tracking" USING "btree" ("lead_id");



CREATE INDEX "idx_mtt_org" ON "public"."message_technique_tracking" USING "btree" ("organization_id", "created_at" DESC);



CREATE INDEX "idx_mtt_technique" ON "public"."message_technique_tracking" USING "btree" ("organization_id", "technique_id");



CREATE INDEX "idx_nurture_due" ON "public"."lead_nurture_state" USING "btree" ("organization_id", "next_action_at") WHERE ("paused" = false);



CREATE INDEX "idx_oauth_states_expires_at" ON "public"."oauth_states" USING "btree" ("expires_at");



CREATE INDEX "idx_org_goals_org_period" ON "public"."org_goals" USING "btree" ("organization_id", "period_end" DESC);



CREATE INDEX "idx_patient_contracts_case" ON "public"."patient_contracts" USING "btree" ("clinical_case_id");



CREATE INDEX "idx_patient_contracts_lead" ON "public"."patient_contracts" USING "btree" ("lead_id") WHERE ("lead_id" IS NOT NULL);



CREATE INDEX "idx_patient_contracts_org_status" ON "public"."patient_contracts" USING "btree" ("organization_id", "status");



CREATE UNIQUE INDEX "idx_patient_contracts_share_token" ON "public"."patient_contracts" USING "btree" ("share_token");



CREATE INDEX "idx_patient_profiles_lead" ON "public"."patient_profiles" USING "btree" ("lead_id");



CREATE INDEX "idx_patient_profiles_org" ON "public"."patient_profiles" USING "btree" ("organization_id");



CREATE UNIQUE INDEX "idx_patients_ehr_unique" ON "public"."patients" USING "btree" ("organization_id", "ehr_source", "ehr_patient_id");



CREATE INDEX "idx_patients_email_hash" ON "public"."patients" USING "btree" ("organization_id", "email_hash") WHERE ("email_hash" IS NOT NULL);



CREATE INDEX "idx_patients_name_dob" ON "public"."patients" USING "btree" ("organization_id", "lower"("first_name"), "lower"("last_name"), "dob");



CREATE INDEX "idx_patients_org_lead" ON "public"."patients" USING "btree" ("organization_id", "lead_id") WHERE ("lead_id" IS NOT NULL);



CREATE INDEX "idx_patients_phone_hash" ON "public"."patients" USING "btree" ("organization_id", "phone_hash") WHERE ("phone_hash" IS NOT NULL);



CREATE INDEX "idx_pipeline_stages_org_pos" ON "public"."pipeline_stages" USING "btree" ("organization_id", "position");



CREATE UNIQUE INDEX "idx_pipeline_stages_org_slug" ON "public"."pipeline_stages" USING "btree" ("organization_id", "slug");



CREATE INDEX "idx_processed_webhook_events_created" ON "public"."processed_webhook_events" USING "btree" ("created_at");



CREATE INDEX "idx_reactivation_campaigns_org" ON "public"."reactivation_campaigns" USING "btree" ("organization_id", "status");



CREATE INDEX "idx_reactivation_offers_campaign" ON "public"."reactivation_offers" USING "btree" ("reactivation_campaign_id");



CREATE UNIQUE INDEX "idx_reviews_external" ON "public"."reviews" USING "btree" ("organization_id", "source", "external_id");



CREATE INDEX "idx_reviews_org_sentiment" ON "public"."reviews" USING "btree" ("organization_id", "sentiment") WHERE ("sentiment" IS NOT NULL);



CREATE INDEX "idx_reviews_org_status" ON "public"."reviews" USING "btree" ("organization_id", "response_status", "reviewed_at" DESC);



CREATE INDEX "idx_roleplay_sessions_org" ON "public"."ai_roleplay_sessions" USING "btree" ("organization_id", "created_at" DESC);



CREATE INDEX "idx_roleplay_sessions_status" ON "public"."ai_roleplay_sessions" USING "btree" ("organization_id", "status");



CREATE INDEX "idx_smart_lists_org" ON "public"."smart_lists" USING "btree" ("organization_id");



CREATE INDEX "idx_smart_lists_pinned" ON "public"."smart_lists" USING "btree" ("organization_id", "is_pinned") WHERE ("is_pinned" = true);



CREATE INDEX "idx_stripe_payments_customer" ON "public"."stripe_payments" USING "btree" ("organization_id", "stripe_customer_id");



CREATE INDEX "idx_stripe_payments_email_hash" ON "public"."stripe_payments" USING "btree" ("organization_id", "email_hash") WHERE ("email_hash" IS NOT NULL);



CREATE UNIQUE INDEX "idx_stripe_payments_event_unique" ON "public"."stripe_payments" USING "btree" ("organization_id", "stripe_event_id");



CREATE INDEX "idx_stripe_payments_lead" ON "public"."stripe_payments" USING "btree" ("lead_id") WHERE ("lead_id" IS NOT NULL);



CREATE INDEX "idx_stripe_payments_object" ON "public"."stripe_payments" USING "btree" ("organization_id", "stripe_object_id");



CREATE INDEX "idx_stripe_payments_pending_forward" ON "public"."stripe_payments" USING "btree" ("organization_id", "occurred_at") WHERE ("forwarded" = false);



CREATE INDEX "idx_stripe_webhook_events_event" ON "public"."stripe_webhook_events" USING "btree" ("stripe_event_id");



CREATE INDEX "idx_stripe_webhook_events_org_received" ON "public"."stripe_webhook_events" USING "btree" ("organization_id", "received_at" DESC);



CREATE INDEX "idx_tags_org_category" ON "public"."tags" USING "btree" ("organization_id", "category");



CREATE UNIQUE INDEX "idx_tags_org_slug" ON "public"."tags" USING "btree" ("organization_id", "slug");



CREATE INDEX "idx_training_examples_active" ON "public"."ai_training_examples" USING "btree" ("organization_id", "agent_target", "is_active");



CREATE INDEX "idx_training_examples_session" ON "public"."ai_training_examples" USING "btree" ("session_id");



CREATE INDEX "idx_treatment_closings_org" ON "public"."treatment_closings" USING "btree" ("organization_id");



CREATE INDEX "idx_treatment_closings_step" ON "public"."treatment_closings" USING "btree" ("organization_id", "current_step");



CREATE INDEX "idx_treatment_closings_surgery" ON "public"."treatment_closings" USING "btree" ("surgery_date") WHERE ("surgery_date" IS NOT NULL);



CREATE INDEX "idx_treatment_outcomes_lead" ON "public"."treatment_outcomes" USING "btree" ("lead_id");



CREATE INDEX "idx_treatment_outcomes_org_occurred" ON "public"."treatment_outcomes" USING "btree" ("organization_id", "occurred_at" DESC);



CREATE UNIQUE INDEX "idx_treatment_plans_ehr_unique" ON "public"."treatment_plans" USING "btree" ("organization_id", "ehr_source", "ehr_treatment_plan_id");



CREATE INDEX "idx_treatment_plans_org_status" ON "public"."treatment_plans" USING "btree" ("organization_id", "status_id", "ehr_last_updated_on" DESC);



CREATE INDEX "idx_treatment_plans_patient" ON "public"."treatment_plans" USING "btree" ("patient_id", "status_id");



CREATE UNIQUE INDEX "idx_treatment_procedures_ehr_unique" ON "public"."treatment_procedures" USING "btree" ("organization_id", "ehr_source", "ehr_procedure_id");



CREATE INDEX "idx_treatment_procedures_org_status_updated" ON "public"."treatment_procedures" USING "btree" ("organization_id", "status_id", "ehr_last_updated_on" DESC);



CREATE INDEX "idx_treatment_procedures_patient" ON "public"."treatment_procedures" USING "btree" ("patient_id", "status_id");



CREATE INDEX "idx_treatment_procedures_plan" ON "public"."treatment_procedures" USING "btree" ("treatment_plan_id");



CREATE INDEX "idx_user_profiles_org" ON "public"."user_profiles" USING "btree" ("organization_id");



CREATE INDEX "idx_voice_calls_campaign" ON "public"."voice_calls" USING "btree" ("voice_campaign_id");



CREATE INDEX "idx_voice_calls_conversation" ON "public"."voice_calls" USING "btree" ("conversation_id");



CREATE INDEX "idx_voice_calls_created" ON "public"."voice_calls" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_voice_calls_lead" ON "public"."voice_calls" USING "btree" ("lead_id");



CREATE INDEX "idx_voice_calls_org" ON "public"."voice_calls" USING "btree" ("organization_id");



CREATE INDEX "idx_voice_calls_retell" ON "public"."voice_calls" USING "btree" ("retell_call_id");



CREATE INDEX "idx_voice_calls_status" ON "public"."voice_calls" USING "btree" ("status");



CREATE INDEX "idx_voice_campaign_leads_campaign" ON "public"."voice_campaign_leads" USING "btree" ("voice_campaign_id");



CREATE INDEX "idx_voice_campaign_leads_status" ON "public"."voice_campaign_leads" USING "btree" ("status") WHERE ("status" = 'queued'::"text");



CREATE INDEX "idx_voice_campaigns_org" ON "public"."voice_campaigns" USING "btree" ("organization_id");



CREATE INDEX "idx_voice_campaigns_status" ON "public"."voice_campaigns" USING "btree" ("status");



CREATE UNIQUE INDEX "idx_windsor_sync_state_org" ON "public"."windsor_sync_state" USING "btree" ("organization_id");



CREATE OR REPLACE TRIGGER "ai_knowledge_articles_updated_at" BEFORE UPDATE ON "public"."ai_knowledge_articles" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "ai_memories_updated_at" BEFORE UPDATE ON "public"."ai_memories" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "ai_test_conversations_updated_at" BEFORE UPDATE ON "public"."ai_test_conversations" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "appointment_reminders_updated_at" BEFORE UPDATE ON "public"."appointment_reminders" FOR EACH ROW EXECUTE FUNCTION "public"."update_appointment_reminders_updated_at"();



CREATE OR REPLACE TRIGGER "booking_settings_updated_at" BEFORE UPDATE ON "public"."booking_settings" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "guard_user_profile_privileged_columns" BEFORE UPDATE ON "public"."user_profiles" FOR EACH ROW EXECUTE FUNCTION "public"."guard_user_profile_privileged_columns"();



CREATE OR REPLACE TRIGGER "log_lead_consent_change" AFTER INSERT OR UPDATE OF "sms_consent", "sms_opt_out", "email_consent", "email_opt_out", "voice_consent", "voice_opt_out", "do_not_call" ON "public"."leads" FOR EACH ROW EXECUTE FUNCTION "public"."log_consent_change"();



CREATE OR REPLACE TRIGGER "on_message_insert" AFTER INSERT ON "public"."messages" FOR EACH ROW EXECUTE FUNCTION "public"."update_conversation_on_message"();



CREATE OR REPLACE TRIGGER "seed_pipeline_stages_on_org_create" AFTER INSERT ON "public"."organizations" FOR EACH ROW EXECUTE FUNCTION "public"."seed_default_pipeline_stages"();



CREATE OR REPLACE TRIGGER "seed_reactivation_on_org_create" AFTER INSERT ON "public"."organizations" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_seed_reactivation_campaign"();



CREATE OR REPLACE TRIGGER "set_ad_spend_daily_updated_at" BEFORE UPDATE ON "public"."ad_spend_daily" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "set_agency_active_org_updated_at" BEFORE UPDATE ON "public"."agency_active_org" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "set_appointments_updated_at" BEFORE UPDATE ON "public"."appointments" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "set_brex_sync_state_updated_at" BEFORE UPDATE ON "public"."brex_sync_state" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "set_campaign_enrollments_updated_at" BEFORE UPDATE ON "public"."campaign_enrollments" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "set_campaigns_updated_at" BEFORE UPDATE ON "public"."campaigns" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "set_case_diagnosis_updated_at" BEFORE UPDATE ON "public"."case_diagnosis" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "set_case_number" BEFORE INSERT ON "public"."clinical_cases" FOR EACH ROW WHEN ((("new"."case_number" IS NULL) OR ("new"."case_number" = ''::"text"))) EXECUTE FUNCTION "public"."generate_case_number"();



CREATE OR REPLACE TRIGGER "set_clinical_cases_updated_at" BEFORE UPDATE ON "public"."clinical_cases" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "set_content_assets_updated_at" BEFORE UPDATE ON "public"."practice_content_assets" FOR EACH ROW EXECUTE FUNCTION "public"."update_content_assets_updated_at"();



CREATE OR REPLACE TRIGGER "set_contract_templates_updated_at" BEFORE UPDATE ON "public"."contract_templates" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "set_conversations_updated_at" BEFORE UPDATE ON "public"."conversations" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "set_ehr_sync_state_updated_at" BEFORE UPDATE ON "public"."ehr_sync_state" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "set_expense_line_items_updated_at" BEFORE UPDATE ON "public"."expense_line_items" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "set_invoices_updated_at" BEFORE UPDATE ON "public"."invoices" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "set_leads_updated_at" BEFORE UPDATE ON "public"."leads" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "set_organizations_updated_at" BEFORE UPDATE ON "public"."organizations" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "set_patient_contracts_updated_at" BEFORE UPDATE ON "public"."patient_contracts" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "set_patients_updated_at" BEFORE UPDATE ON "public"."patients" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "set_reactivation_campaigns_updated_at" BEFORE UPDATE ON "public"."reactivation_campaigns" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "set_reactivation_offers_updated_at" BEFORE UPDATE ON "public"."reactivation_offers" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "set_reviews_updated_at" BEFORE UPDATE ON "public"."reviews" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "set_smart_lists_updated_at" BEFORE UPDATE ON "public"."smart_lists" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "set_stripe_payments_updated_at" BEFORE UPDATE ON "public"."stripe_payments" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "set_treatment_closings_updated_at" BEFORE UPDATE ON "public"."treatment_closings" FOR EACH ROW EXECUTE FUNCTION "public"."update_treatment_closings_updated_at"();



CREATE OR REPLACE TRIGGER "set_treatment_plans_updated_at" BEFORE UPDATE ON "public"."case_treatment_plans" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "set_treatment_plans_updated_at" BEFORE UPDATE ON "public"."treatment_plans" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "set_treatment_procedures_updated_at" BEFORE UPDATE ON "public"."treatment_procedures" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "set_user_profiles_updated_at" BEFORE UPDATE ON "public"."user_profiles" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "set_windsor_sync_state_updated_at" BEFORE UPDATE ON "public"."windsor_sync_state" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "sync_lead_consent_status" BEFORE INSERT OR UPDATE OF "sms_consent", "sms_opt_out", "sms_consent_status", "email_consent", "email_opt_out", "email_consent_status", "voice_consent", "voice_opt_out", "do_not_call", "voice_consent_status" ON "public"."leads" FOR EACH ROW EXECUTE FUNCTION "public"."sync_consent_status"();



CREATE OR REPLACE TRIGGER "trg_attribute_message_to_agent" BEFORE INSERT ON "public"."messages" FOR EACH ROW EXECUTE FUNCTION "public"."attribute_message_to_agent"();



CREATE OR REPLACE TRIGGER "trg_consent_log_append_only" BEFORE DELETE OR UPDATE ON "public"."consent_log" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_row_mutation"();



CREATE OR REPLACE TRIGGER "trg_contract_immutability" BEFORE UPDATE ON "public"."patient_contracts" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_contract_immutability"();



CREATE OR REPLACE TRIGGER "trg_hipaa_audit_append_only" BEFORE DELETE OR UPDATE ON "public"."hipaa_audit_log" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_row_mutation"();



CREATE OR REPLACE TRIGGER "trg_notify_growth_studio" AFTER UPDATE OF "status" ON "public"."leads" FOR EACH ROW EXECUTE FUNCTION "public"."notify_growth_studio_lead_event"();



CREATE OR REPLACE TRIGGER "trg_resolve_lead_source" BEFORE INSERT ON "public"."leads" FOR EACH ROW EXECUTE FUNCTION "public"."resolve_lead_source_id"();



CREATE OR REPLACE TRIGGER "trg_seed_agent_lead_caps" AFTER INSERT ON "public"."ai_agents" FOR EACH ROW EXECUTE FUNCTION "public"."seed_agent_lead_caps"();



CREATE OR REPLACE TRIGGER "trg_seed_agent_status_current" AFTER INSERT ON "public"."ai_agents" FOR EACH ROW EXECUTE FUNCTION "public"."seed_agent_status_current"();



CREATE OR REPLACE TRIGGER "trg_seed_default_agents" AFTER INSERT ON "public"."organizations" FOR EACH ROW EXECUTE FUNCTION "public"."seed_default_agents_for_org"();



CREATE OR REPLACE TRIGGER "trigger_patient_profile_updated" BEFORE UPDATE ON "public"."patient_profiles" FOR EACH ROW EXECUTE FUNCTION "public"."update_patient_profile_timestamp"();



CREATE OR REPLACE TRIGGER "update_roleplay_sessions_updated_at" BEFORE UPDATE ON "public"."ai_roleplay_sessions" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_tag_count_on_lead_tag_change" AFTER INSERT OR DELETE ON "public"."lead_tags" FOR EACH ROW EXECUTE FUNCTION "public"."update_tag_lead_count"();



CREATE OR REPLACE TRIGGER "update_training_examples_updated_at" BEFORE UPDATE ON "public"."ai_training_examples" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "voice_calls_updated_at" BEFORE UPDATE ON "public"."voice_calls" FOR EACH ROW EXECUTE FUNCTION "public"."update_voice_updated_at"();



CREATE OR REPLACE TRIGGER "voice_campaign_leads_updated_at" BEFORE UPDATE ON "public"."voice_campaign_leads" FOR EACH ROW EXECUTE FUNCTION "public"."update_voice_updated_at"();



CREATE OR REPLACE TRIGGER "voice_campaigns_updated_at" BEFORE UPDATE ON "public"."voice_campaigns" FOR EACH ROW EXECUTE FUNCTION "public"."update_voice_updated_at"();



ALTER TABLE ONLY "public"."ad_metrics_daily"
    ADD CONSTRAINT "ad_metrics_daily_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ad_metrics_sync_state"
    ADD CONSTRAINT "ad_metrics_sync_state_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ad_spend_daily"
    ADD CONSTRAINT "ad_spend_daily_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agency_active_org"
    ADD CONSTRAINT "agency_active_org_active_org_id_fkey" FOREIGN KEY ("active_org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agency_active_org"
    ADD CONSTRAINT "agency_active_org_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agency_settings"
    ADD CONSTRAINT "agency_settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."agent_handoffs"
    ADD CONSTRAINT "agent_handoffs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_handoffs"
    ADD CONSTRAINT "agent_handoffs_initiated_by_user_id_fkey" FOREIGN KEY ("initiated_by_user_id") REFERENCES "public"."user_profiles"("id");



ALTER TABLE ONLY "public"."agent_handoffs"
    ADD CONSTRAINT "agent_handoffs_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_handoffs"
    ADD CONSTRAINT "agent_handoffs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_kpi_targets"
    ADD CONSTRAINT "agent_kpi_targets_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."ai_agents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_kpi_targets"
    ADD CONSTRAINT "agent_kpi_targets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_lead_caps"
    ADD CONSTRAINT "agent_lead_caps_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."ai_agents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_lead_caps"
    ADD CONSTRAINT "agent_lead_caps_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_performance_daily"
    ADD CONSTRAINT "agent_performance_daily_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."ai_agents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_performance_daily"
    ADD CONSTRAINT "agent_performance_daily_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_performance_reviews"
    ADD CONSTRAINT "agent_performance_reviews_acknowledged_by_fkey" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."user_profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."agent_performance_reviews"
    ADD CONSTRAINT "agent_performance_reviews_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."ai_agents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_performance_reviews"
    ADD CONSTRAINT "agent_performance_reviews_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_performance_reviews"
    ADD CONSTRAINT "agent_performance_reviews_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user_profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."agent_protocol_changes"
    ADD CONSTRAINT "agent_protocol_changes_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."ai_agents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_protocol_changes"
    ADD CONSTRAINT "agent_protocol_changes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."user_profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."agent_protocol_changes"
    ADD CONSTRAINT "agent_protocol_changes_from_protocol_id_fkey" FOREIGN KEY ("from_protocol_id") REFERENCES "public"."agent_protocols"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."agent_protocol_changes"
    ADD CONSTRAINT "agent_protocol_changes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_protocol_changes"
    ADD CONSTRAINT "agent_protocol_changes_reference_review_id_fkey" FOREIGN KEY ("reference_review_id") REFERENCES "public"."agent_performance_reviews"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."agent_protocol_changes"
    ADD CONSTRAINT "agent_protocol_changes_to_protocol_id_fkey" FOREIGN KEY ("to_protocol_id") REFERENCES "public"."agent_protocols"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."agent_protocols"
    ADD CONSTRAINT "agent_protocols_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."ai_agents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_protocols"
    ADD CONSTRAINT "agent_protocols_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."user_profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."agent_protocols"
    ADD CONSTRAINT "agent_protocols_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_status_current"
    ADD CONSTRAINT "agent_status_current_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."ai_agents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_status_current"
    ADD CONSTRAINT "agent_status_current_last_review_id_fkey" FOREIGN KEY ("last_review_id") REFERENCES "public"."agent_performance_reviews"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."agent_status_current"
    ADD CONSTRAINT "agent_status_current_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_agents"
    ADD CONSTRAINT "ai_agents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_conversation_ratings"
    ADD CONSTRAINT "ai_conversation_ratings_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_conversation_ratings"
    ADD CONSTRAINT "ai_conversation_ratings_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_conversation_ratings"
    ADD CONSTRAINT "ai_conversation_ratings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_conversation_ratings"
    ADD CONSTRAINT "ai_conversation_ratings_rated_by_fkey" FOREIGN KEY ("rated_by") REFERENCES "public"."user_profiles"("id");



ALTER TABLE ONLY "public"."ai_interactions"
    ADD CONSTRAINT "ai_interactions_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ai_interactions"
    ADD CONSTRAINT "ai_interactions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_knowledge_articles"
    ADD CONSTRAINT "ai_knowledge_articles_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."user_profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ai_knowledge_articles"
    ADD CONSTRAINT "ai_knowledge_articles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_memories"
    ADD CONSTRAINT "ai_memories_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."user_profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ai_memories"
    ADD CONSTRAINT "ai_memories_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_roleplay_sessions"
    ADD CONSTRAINT "ai_roleplay_sessions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ai_roleplay_sessions"
    ADD CONSTRAINT "ai_roleplay_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_test_conversations"
    ADD CONSTRAINT "ai_test_conversations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."user_profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ai_test_conversations"
    ADD CONSTRAINT "ai_test_conversations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_training_examples"
    ADD CONSTRAINT "ai_training_examples_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_training_examples"
    ADD CONSTRAINT "ai_training_examples_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."ai_roleplay_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_usage"
    ADD CONSTRAINT "ai_usage_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ai_usage"
    ADD CONSTRAINT "ai_usage_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."appointment_reminders"
    ADD CONSTRAINT "appointment_reminders_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."appointment_reminders"
    ADD CONSTRAINT "appointment_reminders_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."appointment_reminders"
    ADD CONSTRAINT "appointment_reminders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."appointment_reminders"
    ADD CONSTRAINT "appointment_reminders_voice_call_id_fkey" FOREIGN KEY ("voice_call_id") REFERENCES "public"."voice_calls"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."appointments"
    ADD CONSTRAINT "appointments_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "public"."user_profiles"("id");



ALTER TABLE ONLY "public"."appointments"
    ADD CONSTRAINT "appointments_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."appointments"
    ADD CONSTRAINT "appointments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."appointments"
    ADD CONSTRAINT "appointments_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."booking_settings"
    ADD CONSTRAINT "booking_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."brex_sync_state"
    ADD CONSTRAINT "brex_sync_state_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."campaign_enrollments"
    ADD CONSTRAINT "campaign_enrollments_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."campaign_enrollments"
    ADD CONSTRAINT "campaign_enrollments_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."campaign_enrollments"
    ADD CONSTRAINT "campaign_enrollments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."campaign_steps"
    ADD CONSTRAINT "campaign_steps_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."campaign_steps"
    ADD CONSTRAINT "campaign_steps_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."campaigns"
    ADD CONSTRAINT "campaigns_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."user_profiles"("id");



ALTER TABLE ONLY "public"."campaigns"
    ADD CONSTRAINT "campaigns_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."campaigns"
    ADD CONSTRAINT "campaigns_smart_list_id_fkey" FOREIGN KEY ("smart_list_id") REFERENCES "public"."smart_lists"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."case_diagnosis"
    ADD CONSTRAINT "case_diagnosis_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "public"."clinical_cases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."case_diagnosis"
    ADD CONSTRAINT "case_diagnosis_diagnosed_by_fkey" FOREIGN KEY ("diagnosed_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."case_diagnosis"
    ADD CONSTRAINT "case_diagnosis_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."case_files"
    ADD CONSTRAINT "case_files_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "public"."clinical_cases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."case_files"
    ADD CONSTRAINT "case_files_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."case_files"
    ADD CONSTRAINT "case_files_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."case_treatment_plans"
    ADD CONSTRAINT "case_treatment_plans_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "public"."clinical_cases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."case_treatment_plans"
    ADD CONSTRAINT "case_treatment_plans_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."case_treatment_plans"
    ADD CONSTRAINT "case_treatment_plans_planned_by_fkey" FOREIGN KEY ("planned_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."clinical_cases"
    ADD CONSTRAINT "clinical_cases_assigned_doctor_id_fkey" FOREIGN KEY ("assigned_doctor_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."clinical_cases"
    ADD CONSTRAINT "clinical_cases_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."clinical_cases"
    ADD CONSTRAINT "clinical_cases_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."clinical_cases"
    ADD CONSTRAINT "clinical_cases_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."competitors"
    ADD CONSTRAINT "competitors_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."connector_configs"
    ADD CONSTRAINT "connector_configs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."connector_events"
    ADD CONSTRAINT "connector_events_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."connector_events"
    ADD CONSTRAINT "connector_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."consent_capture_tokens"
    ADD CONSTRAINT "consent_capture_tokens_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."consent_capture_tokens"
    ADD CONSTRAINT "consent_capture_tokens_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."consent_log"
    ADD CONSTRAINT "consent_log_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user_profiles"("id");



ALTER TABLE ONLY "public"."consent_log"
    ADD CONSTRAINT "consent_log_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."consent_log"
    ADD CONSTRAINT "consent_log_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contract_events"
    ADD CONSTRAINT "contract_events_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "public"."patient_contracts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contract_events"
    ADD CONSTRAINT "contract_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contract_templates"
    ADD CONSTRAINT "contract_templates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."contract_templates"
    ADD CONSTRAINT "contract_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contract_templates"
    ADD CONSTRAINT "contract_templates_published_by_fkey" FOREIGN KEY ("published_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."conversation_analyses"
    ADD CONSTRAINT "conversation_analyses_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."conversation_analyses"
    ADD CONSTRAINT "conversation_analyses_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."conversation_analyses"
    ADD CONSTRAINT "conversation_analyses_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."conversation_technique_summaries"
    ADD CONSTRAINT "conversation_technique_summaries_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."conversation_technique_summaries"
    ADD CONSTRAINT "conversation_technique_summaries_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."conversation_technique_summaries"
    ADD CONSTRAINT "conversation_technique_summaries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cross_channel_deliveries"
    ADD CONSTRAINT "cross_channel_deliveries_content_asset_id_fkey" FOREIGN KEY ("content_asset_id") REFERENCES "public"."practice_content_assets"("id");



ALTER TABLE ONLY "public"."cross_channel_deliveries"
    ADD CONSTRAINT "cross_channel_deliveries_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cross_channel_deliveries"
    ADD CONSTRAINT "cross_channel_deliveries_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cross_channel_deliveries"
    ADD CONSTRAINT "cross_channel_deliveries_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id");



ALTER TABLE ONLY "public"."cross_channel_deliveries"
    ADD CONSTRAINT "cross_channel_deliveries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."daily_analytics"
    ADD CONSTRAINT "daily_analytics_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ehr_sync_state"
    ADD CONSTRAINT "ehr_sync_state_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."escalations"
    ADD CONSTRAINT "escalations_claimed_by_fkey" FOREIGN KEY ("claimed_by") REFERENCES "public"."user_profiles"("id");



ALTER TABLE ONLY "public"."escalations"
    ADD CONSTRAINT "escalations_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."escalations"
    ADD CONSTRAINT "escalations_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."escalations"
    ADD CONSTRAINT "escalations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."expense_line_items"
    ADD CONSTRAINT "expense_line_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."financing_applications"
    ADD CONSTRAINT "financing_applications_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."financing_applications"
    ADD CONSTRAINT "financing_applications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."financing_lender_configs"
    ADD CONSTRAINT "financing_lender_configs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."financing_submissions"
    ADD CONSTRAINT "financing_submissions_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "public"."financing_applications"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."financing_submissions"
    ADD CONSTRAINT "financing_submissions_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."financing_submissions"
    ADD CONSTRAINT "financing_submissions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."hipaa_audit_log"
    ADD CONSTRAINT "hipaa_audit_log_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."lead_activities"
    ADD CONSTRAINT "lead_activities_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lead_activities"
    ADD CONSTRAINT "lead_activities_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lead_activities"
    ADD CONSTRAINT "lead_activities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id");



ALTER TABLE ONLY "public"."lead_competitor_mentions"
    ADD CONSTRAINT "lead_competitor_mentions_competitor_id_fkey" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."lead_competitor_mentions"
    ADD CONSTRAINT "lead_competitor_mentions_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lead_competitor_mentions"
    ADD CONSTRAINT "lead_competitor_mentions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lead_engagement_assessments"
    ADD CONSTRAINT "lead_engagement_assessments_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lead_engagement_assessments"
    ADD CONSTRAINT "lead_engagement_assessments_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lead_engagement_assessments"
    ADD CONSTRAINT "lead_engagement_assessments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lead_enrichment"
    ADD CONSTRAINT "lead_enrichment_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lead_enrichment"
    ADD CONSTRAINT "lead_enrichment_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lead_nurture_state"
    ADD CONSTRAINT "lead_nurture_state_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lead_nurture_state"
    ADD CONSTRAINT "lead_nurture_state_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lead_sources"
    ADD CONSTRAINT "lead_sources_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lead_tags"
    ADD CONSTRAINT "lead_tags_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lead_tags"
    ADD CONSTRAINT "lead_tags_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lead_tags"
    ADD CONSTRAINT "lead_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lead_tags"
    ADD CONSTRAINT "lead_tags_tagged_by_fkey" FOREIGN KEY ("tagged_by") REFERENCES "public"."user_profiles"("id");



ALTER TABLE ONLY "public"."leads"
    ADD CONSTRAINT "leads_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "public"."user_profiles"("id");



ALTER TABLE ONLY "public"."leads"
    ADD CONSTRAINT "leads_financing_application_id_fkey" FOREIGN KEY ("financing_application_id") REFERENCES "public"."financing_applications"("id");



ALTER TABLE ONLY "public"."leads"
    ADD CONSTRAINT "leads_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."leads"
    ADD CONSTRAINT "leads_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "public"."lead_sources"("id");



ALTER TABLE ONLY "public"."leads"
    ADD CONSTRAINT "leads_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "public"."pipeline_stages"("id");



ALTER TABLE ONLY "public"."mass_send_idempotency"
    ADD CONSTRAINT "mass_send_idempotency_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."message_technique_tracking"
    ADD CONSTRAINT "message_technique_tracking_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."message_technique_tracking"
    ADD CONSTRAINT "message_technique_tracking_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."message_technique_tracking"
    ADD CONSTRAINT "message_technique_tracking_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."ai_agents"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."oauth_states"
    ADD CONSTRAINT "oauth_states_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."oauth_states"
    ADD CONSTRAINT "oauth_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."org_goals"
    ADD CONSTRAINT "org_goals_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."user_profiles"("id");



ALTER TABLE ONLY "public"."org_goals"
    ADD CONSTRAINT "org_goals_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_contracts"
    ADD CONSTRAINT "patient_contracts_case_treatment_plan_id_fkey" FOREIGN KEY ("case_treatment_plan_id") REFERENCES "public"."case_treatment_plans"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."patient_contracts"
    ADD CONSTRAINT "patient_contracts_clinical_case_id_fkey" FOREIGN KEY ("clinical_case_id") REFERENCES "public"."clinical_cases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_contracts"
    ADD CONSTRAINT "patient_contracts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."patient_contracts"
    ADD CONSTRAINT "patient_contracts_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."patient_contracts"
    ADD CONSTRAINT "patient_contracts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_contracts"
    ADD CONSTRAINT "patient_contracts_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."patient_contracts"
    ADD CONSTRAINT "patient_contracts_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "public"."contract_templates"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."patient_contracts"
    ADD CONSTRAINT "patient_contracts_treatment_closing_id_fkey" FOREIGN KEY ("treatment_closing_id") REFERENCES "public"."treatment_closings"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."patient_profiles"
    ADD CONSTRAINT "patient_profiles_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_profiles"
    ADD CONSTRAINT "patient_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patients"
    ADD CONSTRAINT "patients_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."patients"
    ADD CONSTRAINT "patients_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pipeline_stages"
    ADD CONSTRAINT "pipeline_stages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."practice_content_assets"
    ADD CONSTRAINT "practice_content_assets_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."user_profiles"("id");



ALTER TABLE ONLY "public"."practice_content_assets"
    ADD CONSTRAINT "practice_content_assets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."processed_webhook_events"
    ADD CONSTRAINT "processed_webhook_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reactivation_campaigns"
    ADD CONSTRAINT "reactivation_campaigns_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."reactivation_campaigns"
    ADD CONSTRAINT "reactivation_campaigns_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."user_profiles"("id");



ALTER TABLE ONLY "public"."reactivation_campaigns"
    ADD CONSTRAINT "reactivation_campaigns_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reactivation_offers"
    ADD CONSTRAINT "reactivation_offers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reactivation_offers"
    ADD CONSTRAINT "reactivation_offers_reactivation_campaign_id_fkey" FOREIGN KEY ("reactivation_campaign_id") REFERENCES "public"."reactivation_campaigns"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reviews"
    ADD CONSTRAINT "reviews_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reviews"
    ADD CONSTRAINT "reviews_responded_by_fkey" FOREIGN KEY ("responded_by") REFERENCES "public"."user_profiles"("id");



ALTER TABLE ONLY "public"."smart_lists"
    ADD CONSTRAINT "smart_lists_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."user_profiles"("id");



ALTER TABLE ONLY "public"."smart_lists"
    ADD CONSTRAINT "smart_lists_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."stripe_payments"
    ADD CONSTRAINT "stripe_payments_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."stripe_payments"
    ADD CONSTRAINT "stripe_payments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."stripe_payments"
    ADD CONSTRAINT "stripe_payments_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."stripe_webhook_events"
    ADD CONSTRAINT "stripe_webhook_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tags"
    ADD CONSTRAINT "tags_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."user_profiles"("id");



ALTER TABLE ONLY "public"."tags"
    ADD CONSTRAINT "tags_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."treatment_closings"
    ADD CONSTRAINT "treatment_closings_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."treatment_closings"
    ADD CONSTRAINT "treatment_closings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."treatment_outcomes"
    ADD CONSTRAINT "treatment_outcomes_clinical_case_id_fkey" FOREIGN KEY ("clinical_case_id") REFERENCES "public"."clinical_cases"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."treatment_outcomes"
    ADD CONSTRAINT "treatment_outcomes_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."treatment_outcomes"
    ADD CONSTRAINT "treatment_outcomes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."treatment_outcomes"
    ADD CONSTRAINT "treatment_outcomes_treatment_closing_id_fkey" FOREIGN KEY ("treatment_closing_id") REFERENCES "public"."treatment_closings"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."treatment_plans"
    ADD CONSTRAINT "treatment_plans_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."treatment_plans"
    ADD CONSTRAINT "treatment_plans_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."treatment_procedures"
    ADD CONSTRAINT "treatment_procedures_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."treatment_procedures"
    ADD CONSTRAINT "treatment_procedures_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."treatment_procedures"
    ADD CONSTRAINT "treatment_procedures_treatment_plan_id_fkey" FOREIGN KEY ("treatment_plan_id") REFERENCES "public"."treatment_plans"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."user_profiles"
    ADD CONSTRAINT "user_profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_profiles"
    ADD CONSTRAINT "user_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."voice_calls"
    ADD CONSTRAINT "voice_calls_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."voice_calls"
    ADD CONSTRAINT "voice_calls_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."voice_calls"
    ADD CONSTRAINT "voice_calls_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."voice_campaign_leads"
    ADD CONSTRAINT "voice_campaign_leads_last_call_id_fkey" FOREIGN KEY ("last_call_id") REFERENCES "public"."voice_calls"("id");



ALTER TABLE ONLY "public"."voice_campaign_leads"
    ADD CONSTRAINT "voice_campaign_leads_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."voice_campaign_leads"
    ADD CONSTRAINT "voice_campaign_leads_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."voice_campaign_leads"
    ADD CONSTRAINT "voice_campaign_leads_voice_campaign_id_fkey" FOREIGN KEY ("voice_campaign_id") REFERENCES "public"."voice_campaigns"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."voice_campaigns"
    ADD CONSTRAINT "voice_campaigns_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."voice_campaigns"
    ADD CONSTRAINT "voice_campaigns_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."windsor_sync_state"
    ADD CONSTRAINT "windsor_sync_state_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



CREATE POLICY "Admins can delete leads" ON "public"."leads" FOR DELETE USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Admins can manage lead sources" ON "public"."lead_sources" USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Admins can manage pipeline stages" ON "public"."pipeline_stages" USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Agency admins can create organizations" ON "public"."organizations" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."role" = 'agency_admin'::"text")))));



CREATE POLICY "Agency admins can manage agency settings" ON "public"."agency_settings" USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."role" = 'agency_admin'::"text")))));



CREATE POLICY "Authenticated can read a2p status" ON "public"."a2p_status" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Clinical staff can manage case files" ON "public"."case_files" USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"()))));



CREATE POLICY "Clinical staff can manage cases" ON "public"."clinical_cases" USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"()))));



CREATE POLICY "Clinical staff can manage treatment outcomes" ON "public"."treatment_outcomes" USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"())))) WITH CHECK (("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"()))));



CREATE POLICY "Doctors can manage diagnosis" ON "public"."case_diagnosis" USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"()))));



CREATE POLICY "Doctors can manage treatment plans" ON "public"."case_treatment_plans" USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"()))));



CREATE POLICY "Org members can view case files" ON "public"."case_files" FOR SELECT USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"()))));



CREATE POLICY "Org members can view cases" ON "public"."clinical_cases" FOR SELECT USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"()))));



CREATE POLICY "Org members can view diagnosis" ON "public"."case_diagnosis" FOR SELECT USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"()))));



CREATE POLICY "Org members can view treatment outcomes" ON "public"."treatment_outcomes" FOR SELECT USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"()))));



CREATE POLICY "Org members can view treatment plans" ON "public"."case_treatment_plans" FOR SELECT USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"()))));



CREATE POLICY "Owners can update own org" ON "public"."organizations" FOR UPDATE USING (("id" = "public"."get_user_org_id"()));



CREATE POLICY "Owners or agency admins can update organizations" ON "public"."organizations" FOR UPDATE USING ((("id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."role" = ANY (ARRAY['owner'::"text", 'admin'::"text"]))))) OR (EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."role" = 'agency_admin'::"text"))))));



CREATE POLICY "Service role full access" ON "public"."lead_enrichment" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role full access enrichment" ON "public"."lead_enrichment" USING (true) WITH CHECK (true);



CREATE POLICY "Service role full access to reminders" ON "public"."appointment_reminders" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "System can insert AI interactions" ON "public"."ai_interactions" FOR INSERT WITH CHECK (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can create activities in their org" ON "public"."lead_activities" FOR INSERT WITH CHECK (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can create consent tokens in their org" ON "public"."consent_capture_tokens" FOR INSERT WITH CHECK (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can create enrichment in their org" ON "public"."lead_enrichment" FOR INSERT WITH CHECK (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can create leads in their org" ON "public"."leads" FOR INSERT WITH CHECK (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can create messages in their org" ON "public"."messages" FOR INSERT WITH CHECK (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can create org goals in their org" ON "public"."org_goals" FOR INSERT WITH CHECK (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can delete org goals in their org" ON "public"."org_goals" FOR DELETE USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can insert events in their org" ON "public"."events" FOR INSERT WITH CHECK (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can manage appointments in their org" ON "public"."appointments" USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can manage campaign steps in their org" ON "public"."campaign_steps" USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can manage campaigns in their org" ON "public"."campaigns" USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can manage conversations in their org" ON "public"."conversations" USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can manage enrollments in their org" ON "public"."campaign_enrollments" USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can manage lead_tags in their org" ON "public"."lead_tags" USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can manage reactivation campaigns in their org" ON "public"."reactivation_campaigns" USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can manage reactivation offers in their org" ON "public"."reactivation_offers" USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can manage reviews in their org" ON "public"."reviews" USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can manage smart_lists in their org" ON "public"."smart_lists" USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can manage tags in their org" ON "public"."tags" USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can manage their org roleplay sessions" ON "public"."ai_roleplay_sessions" USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"())))) WITH CHECK (("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"()))));



CREATE POLICY "Users can manage their org training examples" ON "public"."ai_training_examples" USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"())))) WITH CHECK (("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"()))));



CREATE POLICY "Users can update leads in their org" ON "public"."leads" FOR UPDATE USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can update org goals in their org" ON "public"."org_goals" FOR UPDATE USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can update their org escalations" ON "public"."escalations" FOR UPDATE USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"()))));



CREATE POLICY "Users can view AI interactions in their org" ON "public"."ai_interactions" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can view activities in their org" ON "public"."lead_activities" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can view ai_usage in their org" ON "public"."ai_usage" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can view analytics in their org" ON "public"."daily_analytics" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can view appointments in their org" ON "public"."appointments" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can view campaign steps in their org" ON "public"."campaign_steps" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can view campaigns in their org" ON "public"."campaigns" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can view consent log in their org" ON "public"."consent_log" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can view consent tokens in their org" ON "public"."consent_capture_tokens" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can view conversations in their org" ON "public"."conversations" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can view enrichment in their org" ON "public"."lead_enrichment" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can view enrollments in their org" ON "public"."campaign_enrollments" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can view events in their org" ON "public"."events" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can view lead sources in their org" ON "public"."lead_sources" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can view leads in their org" ON "public"."leads" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can view messages in their org" ON "public"."messages" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can view nurture state in their org" ON "public"."lead_nurture_state" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can view org goals in their org" ON "public"."org_goals" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can view own org" ON "public"."organizations" FOR SELECT USING (("id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can view own org reminders" ON "public"."appointment_reminders" FOR SELECT USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"()))));



CREATE POLICY "Users can view pipeline stages in their org" ON "public"."pipeline_stages" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can view reactivation campaigns in their org" ON "public"."reactivation_campaigns" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can view reactivation offers in their org" ON "public"."reactivation_offers" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can view reviews in their org" ON "public"."reviews" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can view smart_lists in their org" ON "public"."smart_lists" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can view tags in their org" ON "public"."tags" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users can view their org escalations" ON "public"."escalations" FOR SELECT USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"()))));



CREATE POLICY "Users can view their organization or agency admin sees all" ON "public"."organizations" FOR SELECT USING ((("id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"()))) OR (EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."role" = 'agency_admin'::"text"))))));



CREATE POLICY "Users update expense_line_items in their org" ON "public"."expense_line_items" FOR UPDATE USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users view ad_spend_daily in their org" ON "public"."ad_spend_daily" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users view brex_sync_state in their org" ON "public"."brex_sync_state" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users view ehr_sync_state in their org" ON "public"."ehr_sync_state" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users view expense_line_items in their org" ON "public"."expense_line_items" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users view invoices in their org" ON "public"."invoices" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users view patients in their org" ON "public"."patients" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users view stripe_payments in their org" ON "public"."stripe_payments" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users view stripe_webhook_events in their org" ON "public"."stripe_webhook_events" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users view treatment_plans in their org" ON "public"."treatment_plans" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users view treatment_procedures in their org" ON "public"."treatment_procedures" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "Users view windsor_sync_state in their org" ON "public"."windsor_sync_state" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



ALTER TABLE "public"."a2p_status" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ad_metrics_daily" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ad_metrics_org_read" ON "public"."ad_metrics_daily" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "ad_metrics_service_all" ON "public"."ad_metrics_daily" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."ad_metrics_sync_state" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ad_metrics_sync_state_org_read" ON "public"."ad_metrics_sync_state" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "ad_metrics_sync_state_service_all" ON "public"."ad_metrics_sync_state" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."ad_spend_daily" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "admins_manage_contract_templates" ON "public"."contract_templates" USING ((("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"()))) AND (EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."role" = ANY (ARRAY['doctor_admin'::"text", 'office_manager'::"text", 'owner'::"text", 'admin'::"text"])))))));



ALTER TABLE "public"."agency_active_org" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "agency_active_org_self" ON "public"."agency_active_org" USING (("user_id" = "auth"."uid"())) WITH CHECK ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."role" = 'agency_admin'::"text"))))));



CREATE POLICY "agency_active_org_service" ON "public"."agency_active_org" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."agency_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agent_handoffs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "agent_handoffs_org_isolation" ON "public"."agent_handoffs" USING (("organization_id" = "public"."get_user_org_id"()));



ALTER TABLE "public"."agent_kpi_targets" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "agent_kpi_targets_org_isolation" ON "public"."agent_kpi_targets" USING (("organization_id" = "public"."get_user_org_id"()));



ALTER TABLE "public"."agent_lead_caps" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "agent_lead_caps_org_isolation" ON "public"."agent_lead_caps" USING (("organization_id" = "public"."get_user_org_id"()));



ALTER TABLE "public"."agent_performance_daily" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "agent_performance_daily_org_isolation" ON "public"."agent_performance_daily" USING (("organization_id" = "public"."get_user_org_id"()));



ALTER TABLE "public"."agent_performance_reviews" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "agent_performance_reviews_org_isolation" ON "public"."agent_performance_reviews" USING (("organization_id" = "public"."get_user_org_id"()));



ALTER TABLE "public"."agent_protocol_changes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "agent_protocol_changes_org_isolation" ON "public"."agent_protocol_changes" USING (("organization_id" = "public"."get_user_org_id"()));



ALTER TABLE "public"."agent_protocols" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "agent_protocols_org_isolation" ON "public"."agent_protocols" USING (("organization_id" = "public"."get_user_org_id"()));



ALTER TABLE "public"."agent_status_current" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "agent_status_current_org_isolation" ON "public"."agent_status_current" USING (("organization_id" = "public"."get_user_org_id"()));



ALTER TABLE "public"."ai_agents" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ai_agents_org_isolation" ON "public"."ai_agents" USING (("organization_id" = "public"."get_user_org_id"()));



ALTER TABLE "public"."ai_conversation_ratings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_interactions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_knowledge_articles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ai_knowledge_org_access" ON "public"."ai_knowledge_articles" USING (("organization_id" = "public"."get_user_org_id"()));



ALTER TABLE "public"."ai_memories" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ai_memories_org_access" ON "public"."ai_memories" USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "ai_ratings_org_isolation" ON "public"."ai_conversation_ratings" USING (("organization_id" = "public"."get_user_org_id"())) WITH CHECK (("organization_id" = "public"."get_user_org_id"()));



ALTER TABLE "public"."ai_roleplay_sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_test_conversations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ai_test_convos_org_access" ON "public"."ai_test_conversations" USING (("organization_id" = "public"."get_user_org_id"()));



ALTER TABLE "public"."ai_training_examples" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_usage" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."appointment_reminders" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."appointments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "approvers_manage_contracts" ON "public"."patient_contracts" FOR UPDATE USING ((("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"()))) AND (EXISTS ( SELECT 1
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."role" = ANY (ARRAY['doctor_admin'::"text", 'office_manager'::"text", 'treatment_coordinator'::"text", 'owner'::"text", 'admin'::"text"])))))));



ALTER TABLE "public"."booking_settings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "booking_settings_org_access" ON "public"."booking_settings" USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "booking_settings_public_read" ON "public"."booking_settings" FOR SELECT USING (true);



ALTER TABLE "public"."brex_sync_state" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."campaign_enrollments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."campaign_steps" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."campaigns" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."case_diagnosis" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."case_files" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."case_treatment_plans" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."clinical_cases" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "clinical_staff_insert_contracts" ON "public"."patient_contracts" FOR INSERT WITH CHECK (("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"()))));



ALTER TABLE "public"."competitors" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "competitors_delete" ON "public"."competitors" FOR DELETE USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "competitors_insert" ON "public"."competitors" FOR INSERT WITH CHECK (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "competitors_select" ON "public"."competitors" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "competitors_update" ON "public"."competitors" FOR UPDATE USING (("organization_id" = "public"."get_user_org_id"()));



ALTER TABLE "public"."connector_configs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "connector_configs_org_policy" ON "public"."connector_configs" USING (("organization_id" = "public"."get_user_org_id"())) WITH CHECK (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "connector_configs_service" ON "public"."connector_configs" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."connector_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "connector_events_org_policy" ON "public"."connector_events" USING (("organization_id" = "public"."get_user_org_id"())) WITH CHECK (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "connector_events_service" ON "public"."connector_events" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."consent_capture_tokens" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."consent_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."contract_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."contract_templates" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "conv_analyses_org_access" ON "public"."conversation_analyses" USING (("organization_id" = "public"."get_user_org_id"()));



ALTER TABLE "public"."conversation_analyses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."conversation_technique_summaries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."conversations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cron_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cross_channel_deliveries" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cts_org_access" ON "public"."conversation_technique_summaries" USING (("organization_id" = "public"."get_user_org_id"())) WITH CHECK (("organization_id" = "public"."get_user_org_id"()));



ALTER TABLE "public"."daily_analytics" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ehr_sync_state" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."escalations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."expense_line_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."financing_applications" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "financing_applications_insert" ON "public"."financing_applications" FOR INSERT WITH CHECK (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "financing_applications_select" ON "public"."financing_applications" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "financing_applications_update" ON "public"."financing_applications" FOR UPDATE USING (("organization_id" = "public"."get_user_org_id"()));



ALTER TABLE "public"."financing_lender_configs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "financing_lender_configs_insert" ON "public"."financing_lender_configs" FOR INSERT WITH CHECK (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "financing_lender_configs_select" ON "public"."financing_lender_configs" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "financing_lender_configs_update" ON "public"."financing_lender_configs" FOR UPDATE USING (("organization_id" = "public"."get_user_org_id"()));



ALTER TABLE "public"."financing_submissions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "financing_submissions_insert" ON "public"."financing_submissions" FOR INSERT WITH CHECK (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "financing_submissions_select" ON "public"."financing_submissions" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "financing_submissions_update" ON "public"."financing_submissions" FOR UPDATE USING (("organization_id" = "public"."get_user_org_id"()));



ALTER TABLE "public"."growth_studio_outbox" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."growth_studio_webhook_config" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."hipaa_audit_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "hipaa_audit_org_insert" ON "public"."hipaa_audit_log" FOR INSERT WITH CHECK (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "hipaa_audit_org_select" ON "public"."hipaa_audit_log" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "hipaa_audit_service_insert" ON "public"."hipaa_audit_log" FOR INSERT TO "service_role" WITH CHECK (true);



ALTER TABLE "public"."invoices" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "lea_org_access" ON "public"."lead_engagement_assessments" USING (("organization_id" = "public"."get_user_org_id"())) WITH CHECK (("organization_id" = "public"."get_user_org_id"()));



ALTER TABLE "public"."lead_activities" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lead_competitor_mentions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "lead_competitor_mentions_select" ON "public"."lead_competitor_mentions" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



ALTER TABLE "public"."lead_engagement_assessments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lead_enrichment" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lead_nurture_state" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lead_sources" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lead_tags" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."leads" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."mass_send_idempotency" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."message_technique_tracking" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."messages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "mtt_org_access" ON "public"."message_technique_tracking" USING (("organization_id" = "public"."get_user_org_id"())) WITH CHECK (("organization_id" = "public"."get_user_org_id"()));



ALTER TABLE "public"."oauth_states" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "oauth_states_org_policy" ON "public"."oauth_states" USING (("organization_id" = "public"."get_user_org_id"())) WITH CHECK (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "oauth_states_service" ON "public"."oauth_states" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "org_admins_manage_closings" ON "public"."treatment_closings" USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."role" = ANY (ARRAY['owner'::"text", 'admin'::"text", 'manager'::"text"]))))));



CREATE POLICY "org_admins_manage_content_assets" ON "public"."practice_content_assets" USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE (("user_profiles"."id" = "auth"."uid"()) AND ("user_profiles"."role" = ANY (ARRAY['owner'::"text", 'admin'::"text", 'manager'::"text"]))))));



ALTER TABLE "public"."org_goals" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "org_manage_mass_send_idem" ON "public"."mass_send_idempotency" USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"())))) WITH CHECK (("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"()))));



CREATE POLICY "org_members_read_closings" ON "public"."treatment_closings" FOR SELECT USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"()))));



CREATE POLICY "org_members_read_content_assets" ON "public"."practice_content_assets" FOR SELECT USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"()))));



CREATE POLICY "org_members_read_contract_templates" ON "public"."contract_templates" FOR SELECT USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"()))));



CREATE POLICY "org_members_read_contracts" ON "public"."patient_contracts" FOR SELECT USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"()))));



CREATE POLICY "org_members_read_deliveries" ON "public"."cross_channel_deliveries" FOR SELECT USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"()))));



CREATE POLICY "org_read_contract_events" ON "public"."contract_events" FOR SELECT USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"()))));



ALTER TABLE "public"."organizations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."patient_contracts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."patient_profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "patient_profiles_org_access" ON "public"."patient_profiles" USING (("organization_id" = "public"."get_user_org_id"()));



ALTER TABLE "public"."patients" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pipeline_stages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."practice_content_assets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."processed_webhook_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "processed_webhook_events_service" ON "public"."processed_webhook_events" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."reactivation_campaigns" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "reactivation_campaigns_all" ON "public"."reactivation_campaigns" USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "reactivation_campaigns_select" ON "public"."reactivation_campaigns" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



ALTER TABLE "public"."reactivation_offers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "reactivation_offers_all" ON "public"."reactivation_offers" USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "reactivation_offers_select" ON "public"."reactivation_offers" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



ALTER TABLE "public"."reviews" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "service_role_insert_deliveries" ON "public"."cross_channel_deliveries" FOR INSERT WITH CHECK (true);



CREATE POLICY "service_role_manage_closings" ON "public"."treatment_closings" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "service_role_manage_contract_templates" ON "public"."contract_templates" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "service_role_manage_contracts" ON "public"."patient_contracts" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "service_role_mass_send_idem" ON "public"."mass_send_idempotency" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "service_role_write_contract_events" ON "public"."contract_events" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."smart_lists" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."stripe_payments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."stripe_webhook_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tags" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."treatment_closings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."treatment_outcomes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."treatment_plans" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."treatment_procedures" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_profiles_admin_update" ON "public"."user_profiles" FOR UPDATE USING ((("organization_id" = "public"."get_user_org_id"()) AND "public"."is_admin_role"())) WITH CHECK ((("organization_id" = "public"."get_user_org_id"()) AND "public"."is_admin_role"()));



CREATE POLICY "user_profiles_delete" ON "public"."user_profiles" FOR DELETE USING ((("organization_id" = "public"."get_user_org_id"()) AND "public"."is_admin_role"()));



CREATE POLICY "user_profiles_insert" ON "public"."user_profiles" FOR INSERT WITH CHECK (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "user_profiles_select" ON "public"."user_profiles" FOR SELECT USING (("organization_id" = "public"."get_user_org_id"()));



CREATE POLICY "user_profiles_update" ON "public"."user_profiles" FOR UPDATE USING (("id" = "auth"."uid"())) WITH CHECK (("id" = "auth"."uid"()));



ALTER TABLE "public"."voice_calls" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "voice_calls_org_isolation" ON "public"."voice_calls" USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"()))));



CREATE POLICY "voice_calls_service_role" ON "public"."voice_calls" USING (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."voice_campaign_leads" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "voice_campaign_leads_org_isolation" ON "public"."voice_campaign_leads" USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"()))));



CREATE POLICY "voice_campaign_leads_service_role" ON "public"."voice_campaign_leads" USING (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."voice_campaigns" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "voice_campaigns_org_isolation" ON "public"."voice_campaigns" USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
   FROM "public"."user_profiles"
  WHERE ("user_profiles"."id" = "auth"."uid"()))));



CREATE POLICY "voice_campaigns_service_role" ON "public"."voice_campaigns" USING (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."windsor_sync_state" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";






GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";

























































































































































REVOKE ALL ON FUNCTION "public"."attribute_message_to_agent"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."attribute_message_to_agent"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."attribute_message_to_agent"() TO "service_role";



GRANT ALL ON FUNCTION "public"."auto_enable_rls_on_new_tables"() TO "anon";
GRANT ALL ON FUNCTION "public"."auto_enable_rls_on_new_tables"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."auto_enable_rls_on_new_tables"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."count_ai_messages_last_hour"("p_conversation_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."count_ai_messages_last_hour"("p_conversation_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."count_ai_messages_last_hour"("p_conversation_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."enforce_contract_immutability"() TO "anon";
GRANT ALL ON FUNCTION "public"."enforce_contract_immutability"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."enforce_contract_immutability"() TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_case_number"() TO "anon";
GRANT ALL ON FUNCTION "public"."generate_case_number"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_case_number"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_agent_kpi_summary"("p_org_id" "uuid", "p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_agent_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_agent_kpi_summary"("p_org_id" "uuid", "p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_agent_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_agent_kpi_summary"("p_org_id" "uuid", "p_start" timestamp with time zone, "p_end" timestamp with time zone, "p_agent_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_lead_kpis"("p_org_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_lead_kpis"("p_org_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_lead_kpis"("p_org_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_lead_kpis_ranged"("p_org_id" "uuid", "p_start" timestamp with time zone, "p_end" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."get_lead_kpis_ranged"("p_org_id" "uuid", "p_start" timestamp with time zone, "p_end" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_lead_kpis_ranged"("p_org_id" "uuid", "p_start" timestamp with time zone, "p_end" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_lead_trend"("p_org_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_lead_trend"("p_org_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_lead_trend"("p_org_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_qualification_distribution"("p_org_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_qualification_distribution"("p_org_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_qualification_distribution"("p_org_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_source_breakdown"("p_org_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_source_breakdown"("p_org_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_source_breakdown"("p_org_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_source_roi"("p_org_id" "uuid", "p_start" timestamp with time zone, "p_end" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."get_source_roi"("p_org_id" "uuid", "p_start" timestamp with time zone, "p_end" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_source_roi"("p_org_id" "uuid", "p_start" timestamp with time zone, "p_end" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_user_org_id"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_user_org_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_user_org_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."guard_user_profile_privileged_columns"() TO "anon";
GRANT ALL ON FUNCTION "public"."guard_user_profile_privileged_columns"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."guard_user_profile_privileged_columns"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."handle_auth_user_created"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."handle_auth_user_created"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_auth_user_created"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."increment_asset_usage"("asset_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."increment_asset_usage"("asset_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."increment_asset_usage"("asset_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."insert_qualified_lead"("p_org_id" "uuid", "p_first_name" "text", "p_last_name" "text", "p_phone" "text", "p_phone_formatted" "text", "p_email" "text", "p_city" "text", "p_state" "text", "p_dental_condition" "text", "p_dental_condition_details" "text", "p_has_dentures" boolean, "p_urgency" "text", "p_financing_interest" "text", "p_has_dental_insurance" boolean, "p_budget_range" "text", "p_source_type" "text", "p_utm_source" "text", "p_utm_medium" "text", "p_utm_campaign" "text", "p_utm_content" "text", "p_utm_term" "text", "p_gclid" "text", "p_fbclid" "text", "p_landing_page_url" "text", "p_custom_fields" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."insert_qualified_lead"("p_org_id" "uuid", "p_first_name" "text", "p_last_name" "text", "p_phone" "text", "p_phone_formatted" "text", "p_email" "text", "p_city" "text", "p_state" "text", "p_dental_condition" "text", "p_dental_condition_details" "text", "p_has_dentures" boolean, "p_urgency" "text", "p_financing_interest" "text", "p_has_dental_insurance" boolean, "p_budget_range" "text", "p_source_type" "text", "p_utm_source" "text", "p_utm_medium" "text", "p_utm_campaign" "text", "p_utm_content" "text", "p_utm_term" "text", "p_gclid" "text", "p_fbclid" "text", "p_landing_page_url" "text", "p_custom_fields" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."insert_qualified_lead"("p_org_id" "uuid", "p_first_name" "text", "p_last_name" "text", "p_phone" "text", "p_phone_formatted" "text", "p_email" "text", "p_city" "text", "p_state" "text", "p_dental_condition" "text", "p_dental_condition_details" "text", "p_has_dentures" boolean, "p_urgency" "text", "p_financing_interest" "text", "p_has_dental_insurance" boolean, "p_budget_range" "text", "p_source_type" "text", "p_utm_source" "text", "p_utm_medium" "text", "p_utm_campaign" "text", "p_utm_content" "text", "p_utm_term" "text", "p_gclid" "text", "p_fbclid" "text", "p_landing_page_url" "text", "p_custom_fields" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_admin_role"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_admin_role"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_admin_role"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_agency_admin"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_agency_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_agency_admin"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."log_consent_change"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."log_consent_change"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."log_consent_change"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."notify_growth_studio_lead_event"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."notify_growth_studio_lead_event"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."notify_growth_studio_lead_event"() TO "service_role";



GRANT ALL ON FUNCTION "public"."prevent_row_mutation"() TO "anon";
GRANT ALL ON FUNCTION "public"."prevent_row_mutation"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."prevent_row_mutation"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."reconcile_growth_studio_outbox"("max_retries" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reconcile_growth_studio_outbox"("max_retries" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."refresh_agent_performance_daily"("p_org_id" "uuid", "p_date" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."refresh_agent_performance_daily"("p_org_id" "uuid", "p_date" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."refresh_agent_performance_daily"("p_org_id" "uuid", "p_date" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."resolve_lead_source_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."resolve_lead_source_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."resolve_lead_source_id"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."seed_agent_lead_caps"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."seed_agent_lead_caps"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."seed_agent_lead_caps"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."seed_agent_status_current"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."seed_agent_status_current"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."seed_agent_status_current"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."seed_default_agents_for_org"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."seed_default_agents_for_org"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."seed_default_agents_for_org"() TO "service_role";



GRANT ALL ON FUNCTION "public"."seed_default_pipeline_stages"() TO "anon";
GRANT ALL ON FUNCTION "public"."seed_default_pipeline_stages"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."seed_default_pipeline_stages"() TO "service_role";



GRANT ALL ON FUNCTION "public"."seed_reactivation_campaign"("p_org_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."seed_reactivation_campaign"("p_org_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."seed_reactivation_campaign"("p_org_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."sync_consent_status"() TO "anon";
GRANT ALL ON FUNCTION "public"."sync_consent_status"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_consent_status"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trigger_seed_reactivation_campaign"() TO "anon";
GRANT ALL ON FUNCTION "public"."trigger_seed_reactivation_campaign"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trigger_seed_reactivation_campaign"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_appointment_reminders_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_appointment_reminders_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_appointment_reminders_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_content_assets_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_content_assets_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_content_assets_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_conversation_on_message"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_conversation_on_message"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_conversation_on_message"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_patient_profile_timestamp"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_patient_profile_timestamp"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_patient_profile_timestamp"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_tag_lead_count"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_tag_lead_count"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_tag_lead_count"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_treatment_closings_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_treatment_closings_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_treatment_closings_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_voice_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_voice_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_voice_updated_at"() TO "service_role";


















GRANT ALL ON TABLE "public"."a2p_status" TO "anon";
GRANT ALL ON TABLE "public"."a2p_status" TO "authenticated";
GRANT ALL ON TABLE "public"."a2p_status" TO "service_role";



GRANT ALL ON TABLE "public"."ad_metrics_daily" TO "anon";
GRANT ALL ON TABLE "public"."ad_metrics_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."ad_metrics_daily" TO "service_role";



GRANT ALL ON TABLE "public"."ad_metrics_sync_state" TO "anon";
GRANT ALL ON TABLE "public"."ad_metrics_sync_state" TO "authenticated";
GRANT ALL ON TABLE "public"."ad_metrics_sync_state" TO "service_role";



GRANT ALL ON TABLE "public"."ad_spend_daily" TO "anon";
GRANT ALL ON TABLE "public"."ad_spend_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."ad_spend_daily" TO "service_role";



GRANT ALL ON TABLE "public"."agency_active_org" TO "anon";
GRANT ALL ON TABLE "public"."agency_active_org" TO "authenticated";
GRANT ALL ON TABLE "public"."agency_active_org" TO "service_role";



GRANT ALL ON TABLE "public"."agency_settings" TO "anon";
GRANT ALL ON TABLE "public"."agency_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."agency_settings" TO "service_role";



GRANT ALL ON TABLE "public"."agent_handoffs" TO "anon";
GRANT ALL ON TABLE "public"."agent_handoffs" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_handoffs" TO "service_role";



GRANT ALL ON TABLE "public"."agent_kpi_targets" TO "anon";
GRANT ALL ON TABLE "public"."agent_kpi_targets" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_kpi_targets" TO "service_role";



GRANT ALL ON TABLE "public"."agent_lead_caps" TO "anon";
GRANT ALL ON TABLE "public"."agent_lead_caps" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_lead_caps" TO "service_role";



GRANT ALL ON TABLE "public"."agent_performance_daily" TO "anon";
GRANT ALL ON TABLE "public"."agent_performance_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_performance_daily" TO "service_role";



GRANT ALL ON TABLE "public"."agent_performance_reviews" TO "anon";
GRANT ALL ON TABLE "public"."agent_performance_reviews" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_performance_reviews" TO "service_role";



GRANT ALL ON TABLE "public"."agent_protocol_changes" TO "anon";
GRANT ALL ON TABLE "public"."agent_protocol_changes" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_protocol_changes" TO "service_role";



GRANT ALL ON TABLE "public"."agent_protocols" TO "anon";
GRANT ALL ON TABLE "public"."agent_protocols" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_protocols" TO "service_role";



GRANT ALL ON TABLE "public"."agent_status_current" TO "anon";
GRANT ALL ON TABLE "public"."agent_status_current" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_status_current" TO "service_role";



GRANT ALL ON TABLE "public"."ai_agents" TO "anon";
GRANT ALL ON TABLE "public"."ai_agents" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_agents" TO "service_role";



GRANT ALL ON TABLE "public"."ai_conversation_ratings" TO "anon";
GRANT ALL ON TABLE "public"."ai_conversation_ratings" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_conversation_ratings" TO "service_role";



GRANT ALL ON TABLE "public"."ai_interactions" TO "anon";
GRANT ALL ON TABLE "public"."ai_interactions" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_interactions" TO "service_role";



GRANT ALL ON TABLE "public"."ai_knowledge_articles" TO "anon";
GRANT ALL ON TABLE "public"."ai_knowledge_articles" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_knowledge_articles" TO "service_role";



GRANT ALL ON TABLE "public"."ai_memories" TO "anon";
GRANT ALL ON TABLE "public"."ai_memories" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_memories" TO "service_role";



GRANT ALL ON TABLE "public"."ai_roleplay_sessions" TO "anon";
GRANT ALL ON TABLE "public"."ai_roleplay_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_roleplay_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."ai_test_conversations" TO "anon";
GRANT ALL ON TABLE "public"."ai_test_conversations" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_test_conversations" TO "service_role";



GRANT ALL ON TABLE "public"."ai_training_examples" TO "anon";
GRANT ALL ON TABLE "public"."ai_training_examples" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_training_examples" TO "service_role";



GRANT ALL ON TABLE "public"."ai_usage" TO "anon";
GRANT ALL ON TABLE "public"."ai_usage" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_usage" TO "service_role";



GRANT ALL ON TABLE "public"."appointment_reminders" TO "anon";
GRANT ALL ON TABLE "public"."appointment_reminders" TO "authenticated";
GRANT ALL ON TABLE "public"."appointment_reminders" TO "service_role";



GRANT ALL ON TABLE "public"."appointments" TO "anon";
GRANT ALL ON TABLE "public"."appointments" TO "authenticated";
GRANT ALL ON TABLE "public"."appointments" TO "service_role";



GRANT ALL ON TABLE "public"."booking_settings" TO "anon";
GRANT ALL ON TABLE "public"."booking_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."booking_settings" TO "service_role";



GRANT ALL ON TABLE "public"."brex_sync_state" TO "anon";
GRANT ALL ON TABLE "public"."brex_sync_state" TO "authenticated";
GRANT ALL ON TABLE "public"."brex_sync_state" TO "service_role";



GRANT ALL ON TABLE "public"."campaign_enrollments" TO "anon";
GRANT ALL ON TABLE "public"."campaign_enrollments" TO "authenticated";
GRANT ALL ON TABLE "public"."campaign_enrollments" TO "service_role";



GRANT ALL ON TABLE "public"."campaign_steps" TO "anon";
GRANT ALL ON TABLE "public"."campaign_steps" TO "authenticated";
GRANT ALL ON TABLE "public"."campaign_steps" TO "service_role";



GRANT ALL ON TABLE "public"."campaigns" TO "anon";
GRANT ALL ON TABLE "public"."campaigns" TO "authenticated";
GRANT ALL ON TABLE "public"."campaigns" TO "service_role";



GRANT ALL ON TABLE "public"."case_diagnosis" TO "anon";
GRANT ALL ON TABLE "public"."case_diagnosis" TO "authenticated";
GRANT ALL ON TABLE "public"."case_diagnosis" TO "service_role";



GRANT ALL ON TABLE "public"."case_files" TO "anon";
GRANT ALL ON TABLE "public"."case_files" TO "authenticated";
GRANT ALL ON TABLE "public"."case_files" TO "service_role";



GRANT ALL ON TABLE "public"."case_treatment_plans" TO "anon";
GRANT ALL ON TABLE "public"."case_treatment_plans" TO "authenticated";
GRANT ALL ON TABLE "public"."case_treatment_plans" TO "service_role";



GRANT ALL ON TABLE "public"."clinical_cases" TO "anon";
GRANT ALL ON TABLE "public"."clinical_cases" TO "authenticated";
GRANT ALL ON TABLE "public"."clinical_cases" TO "service_role";



GRANT ALL ON TABLE "public"."competitors" TO "anon";
GRANT ALL ON TABLE "public"."competitors" TO "authenticated";
GRANT ALL ON TABLE "public"."competitors" TO "service_role";



GRANT ALL ON TABLE "public"."connector_configs" TO "anon";
GRANT ALL ON TABLE "public"."connector_configs" TO "authenticated";
GRANT ALL ON TABLE "public"."connector_configs" TO "service_role";



GRANT ALL ON TABLE "public"."connector_events" TO "anon";
GRANT ALL ON TABLE "public"."connector_events" TO "authenticated";
GRANT ALL ON TABLE "public"."connector_events" TO "service_role";



GRANT ALL ON TABLE "public"."consent_capture_tokens" TO "anon";
GRANT ALL ON TABLE "public"."consent_capture_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."consent_capture_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."consent_log" TO "anon";
GRANT ALL ON TABLE "public"."consent_log" TO "authenticated";
GRANT ALL ON TABLE "public"."consent_log" TO "service_role";



GRANT ALL ON TABLE "public"."contract_events" TO "anon";
GRANT ALL ON TABLE "public"."contract_events" TO "authenticated";
GRANT ALL ON TABLE "public"."contract_events" TO "service_role";



GRANT ALL ON TABLE "public"."contract_templates" TO "anon";
GRANT ALL ON TABLE "public"."contract_templates" TO "authenticated";
GRANT ALL ON TABLE "public"."contract_templates" TO "service_role";



GRANT ALL ON TABLE "public"."conversation_analyses" TO "anon";
GRANT ALL ON TABLE "public"."conversation_analyses" TO "authenticated";
GRANT ALL ON TABLE "public"."conversation_analyses" TO "service_role";



GRANT ALL ON TABLE "public"."conversation_technique_summaries" TO "anon";
GRANT ALL ON TABLE "public"."conversation_technique_summaries" TO "authenticated";
GRANT ALL ON TABLE "public"."conversation_technique_summaries" TO "service_role";



GRANT ALL ON TABLE "public"."conversations" TO "anon";
GRANT ALL ON TABLE "public"."conversations" TO "authenticated";
GRANT ALL ON TABLE "public"."conversations" TO "service_role";



GRANT ALL ON TABLE "public"."cron_runs" TO "anon";
GRANT ALL ON TABLE "public"."cron_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."cron_runs" TO "service_role";



GRANT ALL ON TABLE "public"."cross_channel_deliveries" TO "anon";
GRANT ALL ON TABLE "public"."cross_channel_deliveries" TO "authenticated";
GRANT ALL ON TABLE "public"."cross_channel_deliveries" TO "service_role";



GRANT ALL ON TABLE "public"."daily_analytics" TO "anon";
GRANT ALL ON TABLE "public"."daily_analytics" TO "authenticated";
GRANT ALL ON TABLE "public"."daily_analytics" TO "service_role";



GRANT ALL ON TABLE "public"."ehr_sync_state" TO "anon";
GRANT ALL ON TABLE "public"."ehr_sync_state" TO "authenticated";
GRANT ALL ON TABLE "public"."ehr_sync_state" TO "service_role";



GRANT ALL ON TABLE "public"."escalations" TO "anon";
GRANT ALL ON TABLE "public"."escalations" TO "authenticated";
GRANT ALL ON TABLE "public"."escalations" TO "service_role";



GRANT ALL ON TABLE "public"."events" TO "anon";
GRANT ALL ON TABLE "public"."events" TO "authenticated";
GRANT ALL ON TABLE "public"."events" TO "service_role";



GRANT ALL ON TABLE "public"."expense_line_items" TO "anon";
GRANT ALL ON TABLE "public"."expense_line_items" TO "authenticated";
GRANT ALL ON TABLE "public"."expense_line_items" TO "service_role";



GRANT ALL ON TABLE "public"."financing_applications" TO "anon";
GRANT ALL ON TABLE "public"."financing_applications" TO "authenticated";
GRANT ALL ON TABLE "public"."financing_applications" TO "service_role";



GRANT ALL ON TABLE "public"."financing_lender_configs" TO "anon";
GRANT ALL ON TABLE "public"."financing_lender_configs" TO "authenticated";
GRANT ALL ON TABLE "public"."financing_lender_configs" TO "service_role";



GRANT ALL ON TABLE "public"."financing_submissions" TO "anon";
GRANT ALL ON TABLE "public"."financing_submissions" TO "authenticated";
GRANT ALL ON TABLE "public"."financing_submissions" TO "service_role";



GRANT ALL ON TABLE "public"."growth_studio_outbox" TO "anon";
GRANT ALL ON TABLE "public"."growth_studio_outbox" TO "authenticated";
GRANT ALL ON TABLE "public"."growth_studio_outbox" TO "service_role";



GRANT ALL ON TABLE "public"."growth_studio_webhook_config" TO "anon";
GRANT ALL ON TABLE "public"."growth_studio_webhook_config" TO "authenticated";
GRANT ALL ON TABLE "public"."growth_studio_webhook_config" TO "service_role";



GRANT ALL ON TABLE "public"."hipaa_audit_log" TO "anon";
GRANT ALL ON TABLE "public"."hipaa_audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."hipaa_audit_log" TO "service_role";



GRANT ALL ON TABLE "public"."invoices" TO "anon";
GRANT ALL ON TABLE "public"."invoices" TO "authenticated";
GRANT ALL ON TABLE "public"."invoices" TO "service_role";



GRANT ALL ON TABLE "public"."lead_activities" TO "anon";
GRANT ALL ON TABLE "public"."lead_activities" TO "authenticated";
GRANT ALL ON TABLE "public"."lead_activities" TO "service_role";



GRANT ALL ON TABLE "public"."lead_competitor_mentions" TO "anon";
GRANT ALL ON TABLE "public"."lead_competitor_mentions" TO "authenticated";
GRANT ALL ON TABLE "public"."lead_competitor_mentions" TO "service_role";



GRANT ALL ON TABLE "public"."lead_engagement_assessments" TO "anon";
GRANT ALL ON TABLE "public"."lead_engagement_assessments" TO "authenticated";
GRANT ALL ON TABLE "public"."lead_engagement_assessments" TO "service_role";



GRANT ALL ON TABLE "public"."lead_enrichment" TO "anon";
GRANT ALL ON TABLE "public"."lead_enrichment" TO "authenticated";
GRANT ALL ON TABLE "public"."lead_enrichment" TO "service_role";



GRANT ALL ON TABLE "public"."lead_nurture_state" TO "anon";
GRANT ALL ON TABLE "public"."lead_nurture_state" TO "authenticated";
GRANT ALL ON TABLE "public"."lead_nurture_state" TO "service_role";



GRANT ALL ON TABLE "public"."lead_sources" TO "anon";
GRANT ALL ON TABLE "public"."lead_sources" TO "authenticated";
GRANT ALL ON TABLE "public"."lead_sources" TO "service_role";



GRANT ALL ON TABLE "public"."lead_tags" TO "anon";
GRANT ALL ON TABLE "public"."lead_tags" TO "authenticated";
GRANT ALL ON TABLE "public"."lead_tags" TO "service_role";



GRANT ALL ON TABLE "public"."leads" TO "anon";
GRANT ALL ON TABLE "public"."leads" TO "authenticated";
GRANT ALL ON TABLE "public"."leads" TO "service_role";



GRANT ALL ON TABLE "public"."mass_send_idempotency" TO "anon";
GRANT ALL ON TABLE "public"."mass_send_idempotency" TO "authenticated";
GRANT ALL ON TABLE "public"."mass_send_idempotency" TO "service_role";



GRANT ALL ON TABLE "public"."message_technique_tracking" TO "anon";
GRANT ALL ON TABLE "public"."message_technique_tracking" TO "authenticated";
GRANT ALL ON TABLE "public"."message_technique_tracking" TO "service_role";



GRANT ALL ON TABLE "public"."messages" TO "anon";
GRANT ALL ON TABLE "public"."messages" TO "authenticated";
GRANT ALL ON TABLE "public"."messages" TO "service_role";



GRANT ALL ON TABLE "public"."oauth_states" TO "anon";
GRANT ALL ON TABLE "public"."oauth_states" TO "authenticated";
GRANT ALL ON TABLE "public"."oauth_states" TO "service_role";



GRANT ALL ON TABLE "public"."org_goals" TO "anon";
GRANT ALL ON TABLE "public"."org_goals" TO "authenticated";
GRANT ALL ON TABLE "public"."org_goals" TO "service_role";



GRANT ALL ON TABLE "public"."organizations" TO "anon";
GRANT ALL ON TABLE "public"."organizations" TO "authenticated";
GRANT ALL ON TABLE "public"."organizations" TO "service_role";



GRANT ALL ON TABLE "public"."patient_contracts" TO "anon";
GRANT ALL ON TABLE "public"."patient_contracts" TO "authenticated";
GRANT ALL ON TABLE "public"."patient_contracts" TO "service_role";



GRANT ALL ON TABLE "public"."patient_profiles" TO "anon";
GRANT ALL ON TABLE "public"."patient_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."patient_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."patients" TO "anon";
GRANT ALL ON TABLE "public"."patients" TO "authenticated";
GRANT ALL ON TABLE "public"."patients" TO "service_role";



GRANT ALL ON TABLE "public"."pipeline_stages" TO "anon";
GRANT ALL ON TABLE "public"."pipeline_stages" TO "authenticated";
GRANT ALL ON TABLE "public"."pipeline_stages" TO "service_role";



GRANT ALL ON TABLE "public"."practice_content_assets" TO "anon";
GRANT ALL ON TABLE "public"."practice_content_assets" TO "authenticated";
GRANT ALL ON TABLE "public"."practice_content_assets" TO "service_role";



GRANT ALL ON TABLE "public"."processed_webhook_events" TO "anon";
GRANT ALL ON TABLE "public"."processed_webhook_events" TO "authenticated";
GRANT ALL ON TABLE "public"."processed_webhook_events" TO "service_role";



GRANT ALL ON TABLE "public"."reactivation_campaigns" TO "anon";
GRANT ALL ON TABLE "public"."reactivation_campaigns" TO "authenticated";
GRANT ALL ON TABLE "public"."reactivation_campaigns" TO "service_role";



GRANT ALL ON TABLE "public"."reactivation_offers" TO "anon";
GRANT ALL ON TABLE "public"."reactivation_offers" TO "authenticated";
GRANT ALL ON TABLE "public"."reactivation_offers" TO "service_role";



GRANT ALL ON TABLE "public"."reviews" TO "anon";
GRANT ALL ON TABLE "public"."reviews" TO "authenticated";
GRANT ALL ON TABLE "public"."reviews" TO "service_role";



GRANT ALL ON TABLE "public"."smart_lists" TO "anon";
GRANT ALL ON TABLE "public"."smart_lists" TO "authenticated";
GRANT ALL ON TABLE "public"."smart_lists" TO "service_role";



GRANT ALL ON TABLE "public"."stripe_payments" TO "anon";
GRANT ALL ON TABLE "public"."stripe_payments" TO "authenticated";
GRANT ALL ON TABLE "public"."stripe_payments" TO "service_role";



GRANT ALL ON TABLE "public"."stripe_webhook_events" TO "anon";
GRANT ALL ON TABLE "public"."stripe_webhook_events" TO "authenticated";
GRANT ALL ON TABLE "public"."stripe_webhook_events" TO "service_role";



GRANT ALL ON TABLE "public"."tags" TO "anon";
GRANT ALL ON TABLE "public"."tags" TO "authenticated";
GRANT ALL ON TABLE "public"."tags" TO "service_role";



GRANT ALL ON TABLE "public"."treatment_closings" TO "anon";
GRANT ALL ON TABLE "public"."treatment_closings" TO "authenticated";
GRANT ALL ON TABLE "public"."treatment_closings" TO "service_role";



GRANT ALL ON TABLE "public"."treatment_outcomes" TO "anon";
GRANT ALL ON TABLE "public"."treatment_outcomes" TO "authenticated";
GRANT ALL ON TABLE "public"."treatment_outcomes" TO "service_role";



GRANT ALL ON TABLE "public"."treatment_plans" TO "anon";
GRANT ALL ON TABLE "public"."treatment_plans" TO "authenticated";
GRANT ALL ON TABLE "public"."treatment_plans" TO "service_role";



GRANT ALL ON TABLE "public"."treatment_procedures" TO "anon";
GRANT ALL ON TABLE "public"."treatment_procedures" TO "authenticated";
GRANT ALL ON TABLE "public"."treatment_procedures" TO "service_role";



GRANT ALL ON TABLE "public"."user_profiles" TO "anon";
GRANT ALL ON TABLE "public"."user_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."user_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."voice_calls" TO "anon";
GRANT ALL ON TABLE "public"."voice_calls" TO "authenticated";
GRANT ALL ON TABLE "public"."voice_calls" TO "service_role";



GRANT ALL ON TABLE "public"."voice_campaign_leads" TO "anon";
GRANT ALL ON TABLE "public"."voice_campaign_leads" TO "authenticated";
GRANT ALL ON TABLE "public"."voice_campaign_leads" TO "service_role";



GRANT ALL ON TABLE "public"."voice_campaigns" TO "anon";
GRANT ALL ON TABLE "public"."voice_campaigns" TO "authenticated";
GRANT ALL ON TABLE "public"."voice_campaigns" TO "service_role";



GRANT ALL ON TABLE "public"."windsor_sync_state" TO "anon";
GRANT ALL ON TABLE "public"."windsor_sync_state" TO "authenticated";
GRANT ALL ON TABLE "public"."windsor_sync_state" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";



































