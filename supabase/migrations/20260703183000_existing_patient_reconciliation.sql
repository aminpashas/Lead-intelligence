-- Existing-patient reconciliation
-- ================================
-- WhatConverts (and other) sources create a "lead" for ANY inbound contact —
-- including existing patients calling a tracked number. This flags leads that
-- match a synced EHR patient (the local `patients` mirror, refreshed by the
-- CareStack /sync/patients cron) so they:
--   • drop out of the "new lead" working smart lists,
--   • are never auto-outreached by the AI setter (speed-to-lead gate), and
--   • can later be routed to the front-desk / Dion Desk flow.
-- Detection is a phone_hash / email_hash join — no live EHR call per lead.

alter table public.leads
  add column if not exists is_existing_patient boolean not null default false,
  add column if not exists matched_patient_id uuid references public.patients(id) on delete set null;

-- Fast filtering for smart lists / KPIs that exclude (or isolate) existing patients.
create index if not exists idx_leads_org_existing_patient
  on public.leads(organization_id, is_existing_patient);

comment on column public.leads.is_existing_patient is
  'True when this lead matches a synced EHR patient (patients table) by email/phone hash. Excluded from new-lead pools and AI speed-to-lead outreach.';
comment on column public.leads.matched_patient_id is
  'The patients.id this lead was reconciled to (null when not an existing patient).';
