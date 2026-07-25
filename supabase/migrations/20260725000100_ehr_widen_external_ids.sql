-- Widen EHR external-id columns from integer/bigint to text.
--
-- WHY: CareStack uses numeric ids, so these columns were typed numerically. Most
-- other EMRs (and the aggregators that front them) use GUIDs or opaque strings. A
-- GUID does not fit in an integer, so until this runs NO adapter for a string-id
-- EMR can be written at all. This is the single blocking schema change for
-- multi-EMR support.
--
-- The schema is already internally inconsistent about this, which is the tell:
--   ehr_busy_slots.ehr_appointment_id   text     <- correct
--   ehr_appointments.ehr_appointment_id bigint   <- same concept, wrong type
--
-- Verified against the LIVE database on 2026-07-24 (not the migration files —
-- see docs/MIGRATION_DRIFT.md, the repo files are not the source of prod truth):
--   ehr_appointments.ehr_appointment_id        bigint
--   treatment_procedures.ehr_procedure_id      integer
--   treatment_procedures.ehr_treatment_plan_id integer
--   treatment_procedures.ehr_appointment_id    integer
--   treatment_procedures.ehr_treatment_plan_phase_id integer
--   treatment_procedures.ehr_provider_id       integer
--   treatment_procedures.ehr_location_id       integer
--   invoices.ehr_invoice_id                    integer
--   invoices.ehr_provider_id                   integer
--   invoices.ehr_location_id                   integer
--   treatment_plans.ehr_treatment_plan_id      integer
-- Also verified: no views, no functions, and no generated columns depend on any
-- of them, so the only dependents are the unique indexes below — which Postgres
-- rebuilds automatically as part of ALTER COLUMN ... TYPE.
--
-- IMPACT: this rewrites each table and takes an ACCESS EXCLUSIVE lock for the
-- duration. Live row counts at time of writing: ehr_appointments 216,967,
-- treatment_procedures 17,200, invoices 7,600, treatment_plans 0. Expect seconds,
-- not minutes, but it is NOT online — run it in a maintenance window.
--
-- `using col::text` preserves every existing value; 12345 becomes '12345'. The
-- application already coerces ids to text at the adapter boundary (see
-- toExternalId in src/lib/ehr/port.ts), so it is correct both before and after.
--
-- NOT reversible without a second rewrite: text -> integer would fail on any row
-- a string-id EMR has since written.

alter table public.ehr_appointments
  alter column ehr_appointment_id type text using ehr_appointment_id::text;

alter table public.treatment_procedures
  alter column ehr_procedure_id type text using ehr_procedure_id::text,
  alter column ehr_treatment_plan_id type text using ehr_treatment_plan_id::text,
  alter column ehr_treatment_plan_phase_id type text using ehr_treatment_plan_phase_id::text,
  alter column ehr_appointment_id type text using ehr_appointment_id::text,
  alter column ehr_provider_id type text using ehr_provider_id::text,
  alter column ehr_location_id type text using ehr_location_id::text;

alter table public.invoices
  alter column ehr_invoice_id type text using ehr_invoice_id::text,
  alter column ehr_provider_id type text using ehr_provider_id::text,
  alter column ehr_location_id type text using ehr_location_id::text;

alter table public.treatment_plans
  alter column ehr_treatment_plan_id type text using ehr_treatment_plan_id::text;

-- ehr_invoice_number stays integer: it is a human-facing invoice number that we
-- sort and display numerically, not a join key. Widen it only if an EMR turns up
-- that issues alphanumeric invoice numbers.
