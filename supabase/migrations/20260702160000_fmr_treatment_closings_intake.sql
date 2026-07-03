-- FMR pre-surgical intake bag.
--
-- Patient-entered fields that feed the Full Mouth Reconstruction contract's merge
-- variables. Kept as one JSONB column on treatment_closings — the surgical-episode
-- row that already holds surgery_date, deposit_amount, and records_checklist — so the
-- FMR intake data lives with the surgery it belongs to, and we avoid touching the
-- PII-encrypted `leads` table.
--
-- The resolver (src/lib/contracts/variables.ts) reads this bag best-effort, so the app
-- keeps working before this migration is applied; the intake fields simply resolve
-- empty until it is.

alter table public.treatment_closings
  add column if not exists intake jsonb not null default '{}'::jsonb;

comment on column public.treatment_closings.intake is
  'FMR pre-surgical intake: { preferred_pharmacy, pcp_name, pcp_phone, specialists:[{name,title,phone}], driver_name, driver_phone, emergency_contact_name, emergency_contact_phone, uses_tobacco_vape_marijuana:boolean, preop_date:date-string, discount_amount:number }';
