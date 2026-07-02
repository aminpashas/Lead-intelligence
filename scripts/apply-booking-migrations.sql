-- ════════════════════════════════════════════════════════════════════════
-- Online-booking EHR integration — apply BOTH migrations in the Supabase
-- SQL Editor (Dashboard → SQL Editor → paste → Run). Additive + idempotent;
-- safe to run once or repeatedly. (db push can't be used here — the project's
-- migration history has drift.)
-- ════════════════════════════════════════════════════════════════════════

-- ── Migration 1: 20260701_ehr_appointment_sync.sql ──────────────────────────
alter table public.appointments
  add column if not exists carestack_appointment_id text,
  add column if not exists carestack_sync_status text not null default 'pending'
    check (carestack_sync_status in ('pending','synced','failed','skipped')),
  add column if not exists dion_sync_status text not null default 'pending'
    check (dion_sync_status in ('pending','synced','failed','skipped')),
  add column if not exists ehr_sync_attempts integer not null default 0,
  add column if not exists ehr_sync_error text;

create index if not exists idx_appointments_ehr_sync_pending
  on public.appointments (organization_id)
  where carestack_sync_status in ('pending','failed')
     or dion_sync_status in ('pending','failed');

alter table public.booking_settings
  add column if not exists carestack_location_id text,
  add column if not exists carestack_provider_id text,
  add column if not exists carestack_operatory_id text,
  add column if not exists carestack_appointment_type text;

alter table public.organizations
  add column if not exists dion_practice_id text;

-- ── Migration 2: 20260701_ehr_busy_slots.sql ────────────────────────────────
create table if not exists public.ehr_busy_slots (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ehr_source text not null default 'carestack'
    check (ehr_source in ('carestack', 'open_dental', 'dentrix', 'eaglesoft', 'manual')),
  ehr_appointment_id text not null,
  ehr_patient_id text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text,
  appointment_type text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_ehr_busy_slots_unique
  on public.ehr_busy_slots (organization_id, ehr_source, ehr_appointment_id);

create index if not exists idx_ehr_busy_slots_org_start
  on public.ehr_busy_slots (organization_id, starts_at);

alter table public.ehr_busy_slots enable row level security;

-- Drop-then-create so a re-run doesn't error on an existing policy.
drop policy if exists ehr_busy_slots_org_isolation on public.ehr_busy_slots;
create policy ehr_busy_slots_org_isolation on public.ehr_busy_slots
  for all
  using (organization_id = get_user_org_id())
  with check (organization_id = get_user_org_id());
