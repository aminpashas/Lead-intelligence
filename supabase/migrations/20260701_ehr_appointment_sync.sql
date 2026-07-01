-- EHR appointment sync: track per-leg sync state on appointments, hold CareStack
-- booking defaults per org, and carry the Dion federation practice id.
-- Phase 1 of the CareStack + Dion Clinical online-booking integration (schema only;
-- no code reads these yet). All additive + idempotent.

-- 1. appointments: per-leg sync status + CareStack's id for the created appointment.
alter table public.appointments
  add column if not exists carestack_appointment_id text,
  add column if not exists carestack_sync_status text not null default 'pending'
    check (carestack_sync_status in ('pending','synced','failed','skipped')),
  add column if not exists dion_sync_status text not null default 'pending'
    check (dion_sync_status in ('pending','synced','failed','skipped')),
  add column if not exists ehr_sync_attempts integer not null default 0,
  add column if not exists ehr_sync_error text;

-- Partial index for the retry cron (rows with any leg still needing work).
create index if not exists idx_appointments_ehr_sync_pending
  on public.appointments (organization_id)
  where carestack_sync_status in ('pending','failed')
     or dion_sync_status in ('pending','failed');

-- 2. booking_settings: CareStack booking defaults (nullable; adapter falls back
--    to the first location/provider from the API when unset).
alter table public.booking_settings
  add column if not exists carestack_location_id text,
  add column if not exists carestack_provider_id text,
  add column if not exists carestack_operatory_id text,
  add column if not exists carestack_appointment_type text;

-- 3. organizations: Dion federation practice id (dionPracticeId on the bus envelope).
alter table public.organizations
  add column if not exists dion_practice_id text;
