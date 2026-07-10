-- ============================================================================
-- consent_log: FK ON DELETE CASCADE → SET NULL (unblock lead deletion)
-- ============================================================================
-- consent_log is append-only (WORM) via trg_consent_log_append_only (see
-- 20260604_append_only_audit_logs.sql). Its FK to leads was ON DELETE CASCADE,
-- so deleting a lead cascaded a DELETE into consent_log and tripped the
-- append-only trigger:
--
--     ERROR: Table public.consent_log is append-only — DELETE is not permitted
--
-- Net effect: deleting ANY lead that has a consent record fails — the app's
-- "Delete Lead" handler (src/app/api/leads/[id]/route.ts) does a plain
-- leads.delete(), so it 500s for every lead with consent history. The 20260604
-- migration's note that "no code path DELETEs these tables" missed this cascade.
--
-- Fix: retain the TCPA consent proof but detach it from the deleted lead —
-- ON DELETE SET NULL. The WORM record stays intact (it still evidences that the
-- phone consented at a point in time, with org + timestamp) while leads become
-- deletable again. SET NULL requires lead_id to be nullable.
--
-- consent_log is the ONLY append-only table with a cascading FK from leads
-- (audit_events and hipaa_audit_log have no FK to leads.id), so this single
-- change fully restores lead deletion.
-- ============================================================================

alter table public.consent_log
  alter column lead_id drop not null;

alter table public.consent_log
  drop constraint consent_log_lead_id_fkey;

alter table public.consent_log
  add constraint consent_log_lead_id_fkey
  foreign key (lead_id) references public.leads(id) on delete set null;
