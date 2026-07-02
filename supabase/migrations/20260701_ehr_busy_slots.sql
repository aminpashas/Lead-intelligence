-- EHR busy slots: external appointment occupancy pulled from the PMS (CareStack)
-- so LI's availability engine never offers a chair that's actually taken. These are
-- NOT LI bookings (the patients may not be LI leads), hence a dedicated table rather
-- than public.appointments (whose lead_id is NOT NULL).
-- Phase 5 of the CareStack + Dion Clinical online-booking integration.

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

-- Idempotent upsert target for the sync.
create unique index if not exists idx_ehr_busy_slots_unique
  on public.ehr_busy_slots (organization_id, ehr_source, ehr_appointment_id);

-- Availability reads scan an org's upcoming window.
create index if not exists idx_ehr_busy_slots_org_start
  on public.ehr_busy_slots (organization_id, starts_at);

alter table public.ehr_busy_slots enable row level security;

-- Tenant isolation, consistent with the other EHR tables (get_user_org_id()).
create policy ehr_busy_slots_org_isolation on public.ehr_busy_slots
  for all
  using (organization_id = get_user_org_id())
  with check (organization_id = get_user_org_id());
