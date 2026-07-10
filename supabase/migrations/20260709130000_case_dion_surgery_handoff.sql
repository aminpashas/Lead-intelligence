-- Dion Clinical surgery hand-off tracking on treatment_closings.
--
-- Lead Intelligence emits `case.treatment_agreed` to Dion Clinical when a patient
-- accepts (see api/cases/patient/[shareToken]/accept). That is a fire-and-forget
-- federation hand-off; until now nothing recorded that it happened, so the CRM
-- had no honest way to show "this case was routed to the clinical team."
--
--   dion_handoff_at        — set when the case.treatment_agreed event is actually
--                            delivered (ok && not skipped). Null = never handed off
--                            (bridge unconfigured, or a verbal close that didn't emit).
--   dion_surgery_status    — cached surgery state pulled back from Dion Clinical's
--                            read-back endpoint (Phase 4). Mirrors scheduling_requests
--                            .status joined to appointments.status: open | scheduled
--                            | dismissed | <appointment status>. Null until first sync.
--   dion_surgery_date      — surgery start date reported back by Dion Clinical (Phase 4).
--   dion_synced_at         — last time we successfully read status back from Dion.
--
-- Read-only display fields; no state machine here — Dion Clinical owns the surgery.

alter table public.treatment_closings
  add column if not exists dion_handoff_at timestamptz,
  add column if not exists dion_surgery_status text,
  add column if not exists dion_surgery_date date,
  add column if not exists dion_synced_at timestamptz;

comment on column public.treatment_closings.dion_handoff_at is
  'When case.treatment_agreed was delivered to Dion Clinical (federation hand-off). Null = not handed off.';
comment on column public.treatment_closings.dion_surgery_status is
  'Cached surgery status read back from Dion Clinical (open|scheduled|dismissed|<appointment status>). Dion Clinical is the system of record.';
comment on column public.treatment_closings.dion_surgery_date is
  'Surgery start date reported back by Dion Clinical (Phase 4 read-back). Display only.';
comment on column public.treatment_closings.dion_synced_at is
  'Last successful status read-back from Dion Clinical.';
