-- ============================================================================
-- audit_row_change: delta-only snapshots + churn gate.
--
-- WHY: audit_events reached 2,740 MB of a 3,674 MB database (75%) in 15 days
-- and filled the disk. The heap is only 163 MB — the bulk is `before`/`after`,
-- which stored a COMPLETE copy of the row twice on every UPDATE. Measured over
-- a 3,000-row sample: 5,222 bytes/event today vs 378 bytes storing only the
-- changed keys — a 92.8% reduction. See [[audit-events-bloat-disk-full]].
--
-- Three changes:
--
--  1. DELTA-ONLY. before/after keep only the columns that actually changed.
--     The unchanged remainder was a verbatim second copy of the row, carried
--     on every one of ~464k leads.update events.
--
--  2. CHURN GATE. When a write touched ONLY system-maintained columns
--     (counters bumped by sending a message, sync ids, enrichment stamps) no
--     human did anything, so no event is written. ~50% of rows. The underlying
--     business action (the SMS itself) is still audited on its own row.
--     An UPDATE that changed nothing at all is likewise skipped.
--
--  3. BUG FIX — diff BEFORE redaction. The previous version redacted first and
--     computed changed_fields second, so two different phone numbers both
--     became the literal '[redacted]', compared EQUAL, and dropped out of
--     changed_fields entirely. Every PHI-column change was recorded as
--     "nothing changed". The diff now runs on raw values; redaction is applied
--     afterwards to the reduced payload.
--
-- INSERT and DELETE still store the full row: there is no diff to reduce
-- against, and the whole point of those events is what was created/destroyed.
-- They are ~20k rows total.
--
-- The derived-column list MIRRORS DERIVED_FIELDS in src/lib/audit/fields.ts.
-- ============================================================================

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
  v_derived constant text[] := array[
    'updated_at','created_at','enriched_at','enrichment_status','last_synced_at',
    'last_contacted_at','last_responded_at','total_sms_sent','total_sms_received',
    'total_messages_sent','total_messages_received','total_calls','total_emails_sent',
    'ghl_contact_id','ai_score_updated_at'
  ];
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

    if v_before is not null and v_after is not null then
      -- Diff on RAW values. Redacting first would collapse every sensitive
      -- column to one shared literal and hide real changes (see header).
      select array_agg(k.key) into v_changed
      from (select key from jsonb_object_keys(v_before || v_after) as t(key)) k
      where (v_before -> k.key) is distinct from (v_after -> k.key);

      -- Churn gate. NULL covers "no column actually changed"; the containment
      -- test covers "only system-maintained columns changed". An empty array
      -- is contained by anything, so it is caught here too.
      if v_changed is null or v_changed <@ v_derived then
        return coalesce(NEW, OLD);
      end if;

      -- Reduce both snapshots to the changed keys.
      v_before := (
        select coalesce(jsonb_object_agg(k, v_before -> k), '{}'::jsonb)
        from unnest(v_changed) k where v_before ? k
      );
      v_after := (
        select coalesce(jsonb_object_agg(k, v_after -> k), '{}'::jsonb)
        from unnest(v_changed) k where v_after ? k
      );
    end if;

    -- Redact AFTER diffing, over the (now small) payload.
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
    -- TOTAL function: auditing must never roll back the business transaction.
    raise warning 'audit_row_change failed for %.%: %', TG_TABLE_SCHEMA, TG_TABLE_NAME, sqlerrm;
  end;
  return coalesce(NEW, OLD);
end;
$$;
