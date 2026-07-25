-- Multi-EMR appointment link state.
--
-- Until now an LI appointment could be linked to exactly one PMS, via the
-- vendor-named columns appointments.carestack_appointment_id / _sync_status.
-- With the EhrAdapter port (src/lib/ehr/port.ts) an org can have more than one
-- EHR configured, so link state becomes per-source.
--
-- Two columns rather than one jsonb blob on purpose:
--   ehr_external_ids  jsonb  — {"<ehr_source>": "<external id>"} per PMS
--   ehr_sync_status   text   — worst-of across all EHR legs, so the
--                              ehr-appointment-sync retry cron can filter on a
--                              plain indexable column instead of a jsonb predicate.
--
-- ADDITIVE AND REVERSIBLE. The legacy carestack_* columns are left in place and
-- still written by the seam for one release, so every existing reader (notably
-- the retry cron's carestack_sync_status filter) keeps working. Drop them in a
-- follow-up once nothing reads them.

alter table public.appointments
  add column if not exists ehr_external_ids jsonb not null default '{}'::jsonb,
  add column if not exists ehr_sync_status text not null default 'pending'
    check (ehr_sync_status in ('pending', 'synced', 'failed', 'skipped'));

comment on column public.appointments.ehr_external_ids is
  'Per-EHR external appointment ids, keyed by ehr_source. e.g. {"carestack":"12345"}';
comment on column public.appointments.ehr_sync_status is
  'Worst-of sync status across all EHR legs (failed > pending > synced > skipped).';

-- Backfill from the CareStack columns so existing rows keep their link and the
-- retry cron does not suddenly see every historical row as pending.
update public.appointments
   set ehr_external_ids = jsonb_build_object('carestack', carestack_appointment_id)
 where carestack_appointment_id is not null
   and ehr_external_ids = '{}'::jsonb;

update public.appointments
   set ehr_sync_status = carestack_sync_status
 where carestack_sync_status is not null
   and carestack_sync_status in ('pending', 'synced', 'failed', 'skipped');

-- The retry cron scans for rows with a leg still needing work.
create index if not exists idx_appointments_ehr_sync_pending
  on public.appointments (organization_id)
  where ehr_sync_status in ('pending', 'failed');
