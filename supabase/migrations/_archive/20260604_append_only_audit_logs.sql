-- ============================================================================
-- Append-only (WORM) compliance logs
-- ============================================================================
-- The HIPAA audit log and TCPA consent log are the records a breach/TCPA defense
-- relies on. Two gaps made them tamperable:
--   1. hipaa_audit_log had a `FOR ALL` RLS policy — any authenticated org user
--      could UPDATE or DELETE their own org's audit rows.
--   2. Nothing blocked the service role (which bypasses RLS) from rewriting them.
--
-- Fix: a BEFORE UPDATE OR DELETE trigger that raises (true append-only, even for
-- the service role), plus split hipaa_audit_log's policy to SELECT + INSERT only.
-- Verified: no code path UPDATEs or DELETEs these tables, so nothing breaks.
-- ============================================================================

create or replace function public.prevent_row_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Table %.% is append-only — % is not permitted',
    tg_table_schema, tg_table_name, tg_op
    using errcode = 'check_violation';
end;
$$;

-- hipaa_audit_log: append-only
drop trigger if exists trg_hipaa_audit_append_only on public.hipaa_audit_log;
create trigger trg_hipaa_audit_append_only
  before update or delete on public.hipaa_audit_log
  for each row execute function public.prevent_row_mutation();

-- consent_log: append-only
drop trigger if exists trg_consent_log_append_only on public.consent_log;
create trigger trg_consent_log_append_only
  before update or delete on public.consent_log
  for each row execute function public.prevent_row_mutation();

-- Tighten hipaa_audit_log RLS: the old `FOR ALL` allowed UPDATE/DELETE. Replace
-- with SELECT (read own org) + INSERT (write own org — some routes log via the
-- authenticated client). No UPDATE/DELETE policy → denied (and the trigger is the
-- hard backstop for the service role too).
drop policy if exists "hipaa_audit_org_access" on public.hipaa_audit_log;

create policy "hipaa_audit_org_select" on public.hipaa_audit_log
  for select using (organization_id = public.get_user_org_id());

create policy "hipaa_audit_org_insert" on public.hipaa_audit_log
  for insert with check (organization_id = public.get_user_org_id());

-- Service role retains full access via its bypass; for clarity, allow it explicitly
-- for inserts that run under the service key.
create policy "hipaa_audit_service_insert" on public.hipaa_audit_log
  for insert to service_role with check (true);
