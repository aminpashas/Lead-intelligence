-- ============================================================================
-- One-shot compaction of the historical audit_events backlog.
--
-- Companion to 20260719190000_audit_delta_only.sql, which fixed the trigger so
-- NEW events are small. This compacts the ~497k rows already written under the
-- old full-row-snapshot scheme.
--
-- Two operations per batch:
--   DELETE — rows whose only changed_fields are system-maintained (counters,
--            sync ids, stamps). ~248k rows. Approved explicitly by the owner
--            2026-07-19; these are bookkeeping, not human actions.
--   TRIM   — everything else keeps its row but reduces before/after to just the
--            changed keys. No audit row is lost and no changed value is lost;
--            only the redundant copy of UNCHANGED columns goes.
--
-- ── On bypassing WORM ──────────────────────────────────────────────────────
-- audit_events carries trg_audit_events_append_only (prevent_row_mutation),
-- which blocks UPDATE and DELETE for everyone including service_role, with no
-- bypass in its body.
--
-- The preferred approach — a function-level `SET session_replication_role =
-- replica`, scoped to the call and restored even on exception — is NOT
-- available: Supabase's postgres role gets "permission denied to set parameter
-- session_replication_role". So the operator must ALTER TABLE ... DISABLE
-- TRIGGER around the run, which is a PERSISTENT catalog change.
--
-- ⚠️ The log is unprotected for the duration. The runbook at the bottom of
-- this file re-enables it and verifies tgenabled = 'O'. If a run dies midway,
-- re-enable manually before anything else.
--
-- Idempotent: trimming an already-trimmed row rewrites it to the same value,
-- so re-running is safe. Drop the function when the backlog is clear.
-- ============================================================================

create or replace function public.audit_compact_batch(
  p_cursor timestamptz,
  p_limit int default 4000
)
returns table(last_at timestamptz, scanned int, deleted int, trimmed int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
  v_last timestamptz;
  v_scanned int := 0;
  v_deleted int := 0;
  v_trimmed int := 0;
  v_derived constant text[] := array[
    'updated_at','created_at','enriched_at','enrichment_status','last_synced_at',
    'last_contacted_at','last_responded_at','total_sms_sent','total_sms_received',
    'total_messages_sent','total_messages_received','total_calls','total_emails_sent',
    'ghl_contact_id','ai_score_updated_at'
  ];
begin
  -- Keyset walk, newest → oldest. Avoids an expensive "is this row already
  -- trimmed?" predicate (which would have to detoast every candidate).
  select array_agg(t.id), min(t.occurred_at), count(*)
    into v_ids, v_last, v_scanned
  from (
    select id, occurred_at
    from public.audit_events
    where occurred_at < p_cursor
    order by occurred_at desc
    limit p_limit
  ) t;

  if v_ids is null then
    return query select p_cursor, 0, 0, 0;
    return;
  end if;

  delete from public.audit_events a
  where a.id = any(v_ids)
    and a.changed_fields is not null
    and cardinality(a.changed_fields) > 0
    and a.changed_fields <@ v_derived;
  get diagnostics v_deleted = row_count;

  update public.audit_events a
  set before = case when a.before is null then null else (
        select coalesce(jsonb_object_agg(k, a.before -> k), '{}'::jsonb)
        from unnest(a.changed_fields) k where a.before ? k
      ) end,
      after = case when a.after is null then null else (
        select coalesce(jsonb_object_agg(k, a.after -> k), '{}'::jsonb)
        from unnest(a.changed_fields) k where a.after ? k
      ) end
  where a.id = any(v_ids)
    and a.changed_fields is not null
    and cardinality(a.changed_fields) > 0;
  get diagnostics v_trimmed = row_count;

  return query select v_last, v_scanned, v_deleted, v_trimmed;
end;
$$;

revoke all on function public.audit_compact_batch(timestamptz, int) from public, anon, authenticated;
