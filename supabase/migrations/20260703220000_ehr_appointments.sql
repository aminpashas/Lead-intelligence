-- CareStack appointments store — feeds the consult rollup (show / no-show /
-- consultation dates onto leads). Populated by syncCareStackAppointments from
-- the /sync/appointments endpoint. 'Blocked' operatory holds are not stored
-- (they carry no patientId).
create table if not exists public.ehr_appointments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  patient_id uuid references public.patients(id) on delete set null,
  ehr_source text not null default 'carestack',
  ehr_appointment_id bigint not null,
  ehr_patient_id text,
  status text,
  start_at timestamptz,
  duration_minutes integer,
  location_id integer,
  provider_ids jsonb,
  operatory_id integer,
  production_type_id integer,
  ehr_last_updated_on timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, ehr_source, ehr_appointment_id)
);

create index if not exists idx_ehr_appointments_patient
  on public.ehr_appointments(patient_id) where patient_id is not null;
create index if not exists idx_ehr_appointments_org_status
  on public.ehr_appointments(organization_id, status);

alter table public.ehr_appointments enable row level security;
