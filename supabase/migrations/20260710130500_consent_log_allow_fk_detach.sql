-- ============================================================================
-- consent_log append-only guard: permit the FK-driven lead detach
-- ============================================================================
-- The companion migration 20260710130000 switched consent_log's FK to
-- ON DELETE SET NULL so leads become deletable again. But SET NULL performs an
-- UPDATE (lead_id -> NULL), and the shared prevent_row_mutation() trigger
-- (20260604_append_only_audit_logs.sql) fires on UPDATE OR DELETE — so lead
-- deletion STILL failed, now on the cascade UPDATE:
--
--     ERROR: Table public.consent_log is append-only — UPDATE is not permitted
--
-- Fix: give consent_log a dedicated append-only guard that blocks all DELETEs
-- and all UPDATEs EXCEPT the narrow FK-detach — nulling lead_id with every other
-- column byte-identical (enforced via jsonb equality). The consent evidence
-- (phone, timestamp, consent_type, organization_id, …) stays fully immutable;
-- only the CRM linkage is severed when the parent lead is deleted.
--
-- hipaa_audit_log keeps the strict shared prevent_row_mutation() guard.
-- ============================================================================

create or replace function public.consent_log_append_only()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Table %.% is append-only — DELETE is not permitted',
      tg_table_schema, tg_table_name using errcode = 'check_violation';
  end if;
  -- UPDATE: allow only nulling lead_id (lead-deletion detach), nothing else.
  if old.lead_id is not null and new.lead_id is null
     and (to_jsonb(new) - 'lead_id') = (to_jsonb(old) - 'lead_id') then
    return new;
  end if;
  raise exception 'Table %.% is append-only — UPDATE is not permitted',
    tg_table_schema, tg_table_name using errcode = 'check_violation';
end;
$$;

drop trigger if exists trg_consent_log_append_only on public.consent_log;
create trigger trg_consent_log_append_only
  before update or delete on public.consent_log
  for each row execute function public.consent_log_append_only();
