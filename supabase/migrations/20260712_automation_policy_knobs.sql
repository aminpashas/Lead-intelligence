-- supabase/migrations/20260712_automation_policy_knobs.sql
-- Per-scope autopilot knobs. NULL = inherit the org-level autopilot default.
alter table public.automation_policies
  add column if not exists confidence_threshold numeric(3,2)
    check (confidence_threshold is null or (confidence_threshold >= 0 and confidence_threshold <= 1)),
  add column if not exists active_hours_start smallint
    check (active_hours_start is null or (active_hours_start >= 0 and active_hours_start <= 23)),
  add column if not exists active_hours_end smallint
    check (active_hours_end is null or (active_hours_end >= 1 and active_hours_end <= 24));

comment on column public.automation_policies.confidence_threshold is
  'Per-scope min AI confidence; NULL inherits organizations.autopilot_confidence_threshold.';
comment on column public.automation_policies.active_hours_start is
  'Per-scope active-hours start (0-23); NULL inherits org autopilot_active_hours_start.';
comment on column public.automation_policies.active_hours_end is
  'Per-scope active-hours end (1-24); NULL inherits org autopilot_active_hours_end.';
