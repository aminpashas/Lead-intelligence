-- ============================================================================
-- Widen the audit trail to (almost) all org-scoped tables, and switch the
-- trigger to universal column-NAME-pattern redaction so newly-audited tables
-- are protected automatically (fail-safe — no per-table denylist to forget).
--
-- Design: docs/superpowers/specs/2026-07-04-full-audit-trail-design.md
-- Follows 20260704160000_audit_events.sql.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Redaction: any column whose NAME matches a sensitive pattern is redacted to
-- '[redacted]' in the before/after snapshot, for EVERY audited table. This is
-- deliberately over-inclusive (over-redaction is safe; changed_fields still
-- records that the column changed). MIRROR of intent in src/lib/audit/redaction.ts.
-- ---------------------------------------------------------------------------
create or replace function public.audit_is_sensitive_col(col text)
returns boolean
language sql
immutable
as $$
  select col ~* '(email|phone|ssn|social_security|birth|dob|insurance|passport|license|account_number|routing|iban|swift|card_number|card_last|cvv|secret|_token|token$|password|api_key|apikey|personal_details|bank|tax_id|\_ein|routing_number|address_line|street|national_id)';
$$;

create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_before jsonb;
  v_after jsonb;
  v_changed text[];
  v_actor_type text;
  v_actor_id text;
  v_col text;
begin
  begin
    v_org := coalesce(
      (to_jsonb(NEW) ->> 'organization_id'),
      (to_jsonb(OLD) ->> 'organization_id')
    )::uuid;
    if v_org is null then
      return coalesce(NEW, OLD);
    end if;

    v_before := case when TG_OP = 'INSERT' then null else to_jsonb(OLD) end;
    v_after  := case when TG_OP = 'DELETE' then null else to_jsonb(NEW) end;

    -- Universal name-pattern redaction across every key of before/after.
    if v_before is not null then
      for v_col in select k from jsonb_object_keys(v_before) k loop
        if public.audit_is_sensitive_col(v_col) then
          v_before := jsonb_set(v_before, array[v_col], '"[redacted]"'::jsonb);
        end if;
      end loop;
    end if;
    if v_after is not null then
      for v_col in select k from jsonb_object_keys(v_after) k loop
        if public.audit_is_sensitive_col(v_col) then
          v_after := jsonb_set(v_after, array[v_col], '"[redacted]"'::jsonb);
        end if;
      end loop;
    end if;

    if v_before is not null and v_after is not null then
      select array_agg(k.key) into v_changed
      from (select key from jsonb_object_keys(v_before || v_after) as t(key)) k
      where (v_before -> k.key) is distinct from (v_after -> k.key);
    end if;

    v_actor_type := coalesce(nullif(current_setting('app.actor_type', true), ''), 'system');
    v_actor_id := nullif(current_setting('app.actor_id', true), '');
    if v_actor_id is null and auth.uid() is not null then
      v_actor_type := 'user';
      v_actor_id := auth.uid()::text;
    end if;

    insert into public.audit_events (
      organization_id, actor_type, actor_id, actor_label, action,
      resource_type, resource_id, source, before, after, changed_fields,
      request_id
    ) values (
      v_org,
      v_actor_type,
      case when v_actor_id ~ '^[0-9a-f-]{36}$' then v_actor_id::uuid else null end,
      nullif(current_setting('app.actor_label', true), ''),
      TG_TABLE_NAME || '.' || lower(TG_OP),
      TG_TABLE_NAME,
      coalesce((to_jsonb(NEW) ->> 'id'), (to_jsonb(OLD) ->> 'id')),
      'db_trigger',
      v_before, v_after, v_changed,
      nullif(current_setting('app.request_id', true), '')
    );
  exception when others then
    raise warning 'audit_row_change failed for %.%: %', TG_TABLE_SCHEMA, TG_TABLE_NAME, sqlerrm;
  end;
  return coalesce(NEW, OLD);
end;
$$;

-- ---------------------------------------------------------------------------
-- Attach audit_row_change to every org-scoped base table EXCEPT the exclusions
-- below. Excludes carry reasons so the coverage boundary is explicit.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  v_excludes text[] := array[
    -- logs / recursion (auditing these would loop or duplicate an existing WORM log)
    'audit_events','hipaa_audit_log','consent_log',
    -- event / webhook / queue / token / idempotency plumbing (machine chatter, not actions)
    'connector_events','contract_events','events','processed_webhook_events',
    'stripe_webhook_events','growth_studio_outbox','mass_send_idempotency',
    'oauth_states','consent_capture_tokens','cross_channel_deliveries',
    -- sync-state / analytics / telemetry rollups (high volume, machine-written)
    'ad_metrics_daily','ad_metrics_sync_state','ad_spend_daily','brex_sync_state',
    'ehr_sync_state','ehr_busy_slots','ehr_appointments','windsor_sync_state',
    'daily_analytics','agent_performance_daily','agent_status_current','agent_kpi_targets',
    'ai_usage','ai_interactions','ai_memories','learning_episodes','cost_events',
    -- comms volume (individual sends are already audited via recordAudit)
    'messages','conversations','conversation_analyses','conversation_technique_summaries',
    'message_technique_tracking','voice_calls','voice_agent_presence','ai_conversation_ratings',
    'ai_roleplay_sessions','ai_test_conversations',
    -- activity / enrichment / cron churn (derived, not user/AI actions)
    'lead_activities','lead_engagement_assessments','lead_enrichment','lead_competitor_mentions',
    'lead_nurture_state','appointment_reminders',
    -- bulk membership (a single campaign can write tens of thousands of rows)
    'campaign_enrollments','voice_campaign_leads'
  ];
  v_count int := 0;
begin
  for t in
    select distinct c.table_name
    from information_schema.columns c
    join information_schema.tables tb
      on tb.table_schema = c.table_schema and tb.table_name = c.table_name
    where c.table_schema = 'public'
      and c.column_name = 'organization_id'
      and tb.table_type = 'BASE TABLE'
      and c.table_name <> all (v_excludes)
  loop
    execute format('drop trigger if exists trg_audit_%1$s on public.%1$I', t);
    execute format(
      'create trigger trg_audit_%1$s after insert or update or delete on public.%1$I
       for each row execute function public.audit_row_change()', t);
    v_count := v_count + 1;
  end loop;
  raise notice 'audit: attached row-change trigger to % org-scoped tables', v_count;
end $$;
