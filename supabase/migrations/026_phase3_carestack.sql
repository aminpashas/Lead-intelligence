-- Migration 026: Phase 3 — CareStack EHR integration
--
-- Adds:
--   1. patients              — links CareStack patientId ↔ our leads.id
--   2. treatment_plans       — mirrors CareStack treatment plans (per Treatment Plan endpoint)
--   3. treatment_procedures  — mirrors CareStack treatment procedures (the revenue-bearing rows)
--   4. invoices              — mirrors CareStack invoice sync (collected revenue)
--   5. ehr_sync_state        — per-org cursor for incremental sync (modifiedSince + continueToken)
--   6. appointments.external_id + .source columns (link CareStack appointmentId)
--   7. extends connector_configs.connector_type with 'carestack'
--
-- Brief reference: Section 4.1 (EHR Integration). Plan: ~/.claude/plans/woolly-tumbling-kite.md

-- ============================================
-- 1. PATIENTS — bridge between CareStack and our leads
-- ============================================
create table public.patients (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- The CareStack patient identifier (CareStack's primary key on their side).
  ehr_patient_id text not null,
  ehr_source text not null default 'carestack' check (ehr_source in ('carestack', 'open_dental', 'dentrix', 'eaglesoft', 'manual')),

  -- Optional link to a lead in our system. When CareStack pushes a patient that
  -- we've never marketed to (walk-in, referral), lead_id stays null until/unless
  -- the matcher finds a fit later.
  lead_id uuid references public.leads(id) on delete set null,
  match_method text check (match_method in ('email_hash', 'phone_hash', 'name_dob', 'manual', 'webhook_meta', 'unmatched')),
  match_confidence numeric(3,2),  -- 0.00–1.00

  -- Mirror of select CareStack patient fields for fast joins.
  -- We don't duplicate everything — full PII stays in CareStack.
  first_name text,
  last_name text,
  email text,
  email_hash text,
  phone_e164 text,
  phone_hash text,
  dob date,
  default_location_id integer,
  account_id integer,                -- CareStack accountId
  status integer,                    -- CareStack patient status enum (0/1/2)

  metadata jsonb default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index idx_patients_ehr_unique
  on public.patients(organization_id, ehr_source, ehr_patient_id);
create index idx_patients_org_lead on public.patients(organization_id, lead_id) where lead_id is not null;
create index idx_patients_email_hash on public.patients(organization_id, email_hash) where email_hash is not null;
create index idx_patients_phone_hash on public.patients(organization_id, phone_hash) where phone_hash is not null;
create index idx_patients_name_dob on public.patients(organization_id, lower(first_name), lower(last_name), dob);

comment on table public.patients is 'Bridge between EHR (CareStack today) patient records and our marketing leads. Nullable lead_id supports patients who arrived outside our funnel (walk-ins, referrals).';

-- ============================================
-- 2. TREATMENT_PLANS — mirrors CareStack TreatmentPlan
-- ============================================
create table public.treatment_plans (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patients(id) on delete cascade,

  ehr_treatment_plan_id integer not null,         -- CareStack TreatmentPlanId
  ehr_source text not null default 'carestack',

  name text,
  -- CareStack TreatmentPlanStatus enum:
  --   0 NotSet, 1 Proposed, 2 Recommended, 3 Accepted, 4 Rejected, 5 Alternative,
  --   6 Hold, 7 ReferredOut, 8 Completed, 9 Presented, 10 ServiceCompleted
  status_id integer not null,
  duration integer,                                -- months or defined unit
  condition_ids text,                              -- comma-separated per CareStack
  coordinator_id integer,

  -- Aggregate $ values rolled up from related treatment_procedures (best-effort cache;
  -- the source of truth is the per-procedure rows).
  total_patient_estimate numeric(12,2),
  total_insurance_estimate numeric(12,2),

  -- Forwarder bookkeeping: we set this to the status_id we last forwarded so we
  -- only fire `lead.treatment_accepted` once per plan, even on resync.
  last_forwarded_status_id integer,
  last_forwarded_at timestamptz,

  metadata jsonb default '{}',
  ehr_last_updated_on timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index idx_treatment_plans_ehr_unique
  on public.treatment_plans(organization_id, ehr_source, ehr_treatment_plan_id);
create index idx_treatment_plans_patient on public.treatment_plans(patient_id, status_id);
create index idx_treatment_plans_org_status on public.treatment_plans(organization_id, status_id, ehr_last_updated_on desc);

-- ============================================
-- 3. TREATMENT_PROCEDURES — the revenue-bearing rows from sync/treatment-procedures
-- ============================================
create table public.treatment_procedures (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid references public.patients(id) on delete cascade,
  treatment_plan_id uuid references public.treatment_plans(id) on delete set null,

  ehr_procedure_id integer not null,             -- CareStack TreatmentProcedure.id
  ehr_source text not null default 'carestack',
  ehr_treatment_plan_id integer,
  ehr_treatment_plan_phase_id integer,
  ehr_appointment_id integer,
  ehr_provider_id integer,
  ehr_location_id integer,

  procedure_code_id integer,
  tooth text,                                    -- comma-separated tooth numbers
  surfaces jsonb,                                -- {b,L,m,o,f,d,i}

  patient_estimate numeric(12,2),
  insurance_estimate numeric(12,2),
  -- CareStack TreatmentProcedureStatus enum (same as TreatmentPlanStatus enum per docs):
  --   1-Proposed, 2-Scheduled, 3-Accepted, 4-Rejected, 5-Alternative, 6-Hold,
  --   7-Referred Out, 8-Completed
  status_id integer,

  proposed_date timestamptz,
  date_of_service timestamptz,

  is_deleted boolean default false,

  -- Forwarder bookkeeping
  last_forwarded_status_id integer,
  last_forwarded_at timestamptz,

  metadata jsonb default '{}',
  ehr_last_updated_on timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index idx_treatment_procedures_ehr_unique
  on public.treatment_procedures(organization_id, ehr_source, ehr_procedure_id);
create index idx_treatment_procedures_patient on public.treatment_procedures(patient_id, status_id);
create index idx_treatment_procedures_plan on public.treatment_procedures(treatment_plan_id);
create index idx_treatment_procedures_org_status_updated
  on public.treatment_procedures(organization_id, status_id, ehr_last_updated_on desc);

-- ============================================
-- 4. INVOICES — mirrors CareStack invoice sync (the actual collected revenue)
-- ============================================
create table public.invoices (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid references public.patients(id) on delete set null,

  ehr_invoice_id integer not null,                -- CareStack InvoiceId
  ehr_invoice_number integer,
  ehr_source text not null default 'carestack',

  amount numeric(12,2) not null,
  unapplied_amount numeric(12,2),
  ehr_provider_id integer,
  ehr_location_id integer,

  payment_category text,                          -- TRANSFER|CASH|CHECK|CREDIT/DEBIT CARD|THIRD PARTY FINANCING|...
  invoice_type integer,                           -- 1 Regular, 2 Advance, 3 Capitation, 4 PaymentPlan
  invoice_source integer,                         -- 1 PMS, 2 TextToPay, 3 PatientPortal
  payment_type_id integer,
  payment_date timestamptz,
  is_nsf boolean default false,
  is_deleted boolean default false,

  -- Forwarder bookkeeping (one Purchase event per invoice)
  forwarded boolean default false,
  forwarded_at timestamptz,

  metadata jsonb default '{}',
  ehr_last_updated_on timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index idx_invoices_ehr_unique
  on public.invoices(organization_id, ehr_source, ehr_invoice_id);
create index idx_invoices_patient on public.invoices(patient_id, payment_date desc);
create index idx_invoices_org_paid
  on public.invoices(organization_id, payment_date desc) where forwarded = false and is_deleted = false;

-- ============================================
-- 5. EHR_SYNC_STATE — per-org cursor for incremental sync
-- ============================================
create table public.ehr_sync_state (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ehr_source text not null default 'carestack',
  resource text not null
    check (resource in ('patients', 'appointments', 'treatment_procedures', 'existing_treatment_procedures', 'invoices', 'accounting_procedures', 'accounting_transactions', 'treatment_plans', 'treatment_phases', 'potential_patients')),

  -- ISO datetime of the last successful sync window's HIGH-WATER mark.
  -- Next sync should pass this as modifiedSince.
  last_synced_at timestamptz,
  -- CareStack pagination continueToken — if a sweep timed out mid-batch we resume here.
  continue_token text,
  last_run_at timestamptz,
  last_run_status text check (last_run_status in ('success', 'failed', 'partial')),
  last_run_count integer,
  last_run_error text,

  metadata jsonb default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index idx_ehr_sync_state_unique
  on public.ehr_sync_state(organization_id, ehr_source, resource);

comment on table public.ehr_sync_state is 'Per-org incremental sync cursor for CareStack (and future EHRs). The sync cron reads last_synced_at, calls CareStack with modifiedSince=that, paginates via continueToken until exhausted, then advances last_synced_at to the high-water mark of the batch.';

-- ============================================
-- 6. APPOINTMENTS — link to CareStack
-- ============================================
alter table public.appointments add column if not exists external_id text;
alter table public.appointments add column if not exists external_source text default 'manual'
  check (external_source in ('manual', 'cal_com', 'carestack'));
alter table public.appointments add column if not exists patient_id uuid references public.patients(id) on delete set null;

create unique index if not exists idx_appointments_external_unique
  on public.appointments(organization_id, external_source, external_id)
  where external_id is not null;

-- ============================================
-- 7. EXTEND connector_configs FOR CARESTACK
-- ============================================
alter table public.connector_configs drop constraint if exists connector_configs_connector_type_check;
alter table public.connector_configs add constraint connector_configs_connector_type_check
  check (connector_type in (
    'google_ads', 'meta_capi', 'ga4', 'outbound_webhook', 'slack', 'google_reviews', 'callrail',
    'cal_com', 'carestack'
  ));

-- ============================================
-- 8. updated_at TRIGGERS
-- ============================================
create trigger set_patients_updated_at
  before update on public.patients
  for each row execute function public.handle_updated_at();
create trigger set_treatment_plans_updated_at
  before update on public.treatment_plans
  for each row execute function public.handle_updated_at();
create trigger set_treatment_procedures_updated_at
  before update on public.treatment_procedures
  for each row execute function public.handle_updated_at();
create trigger set_invoices_updated_at
  before update on public.invoices
  for each row execute function public.handle_updated_at();
create trigger set_ehr_sync_state_updated_at
  before update on public.ehr_sync_state
  for each row execute function public.handle_updated_at();

-- ============================================
-- 9. RLS
-- ============================================
alter table public.patients enable row level security;
alter table public.treatment_plans enable row level security;
alter table public.treatment_procedures enable row level security;
alter table public.invoices enable row level security;
alter table public.ehr_sync_state enable row level security;

create policy "Users view patients in their org"
  on public.patients for select using (organization_id = public.get_user_org_id());
create policy "Users view treatment_plans in their org"
  on public.treatment_plans for select using (organization_id = public.get_user_org_id());
create policy "Users view treatment_procedures in their org"
  on public.treatment_procedures for select using (organization_id = public.get_user_org_id());
create policy "Users view invoices in their org"
  on public.invoices for select using (organization_id = public.get_user_org_id());
create policy "Users view ehr_sync_state in their org"
  on public.ehr_sync_state for select using (organization_id = public.get_user_org_id());

-- All writes happen via the service role from the sync cron + webhook.
-- No write policies for authenticated users (denied by default with RLS on).
