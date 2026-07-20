-- No-Show board stage
-- ===================
-- Until now a no-show was invisible on the kanban. Marking an appointment
-- `no_show` set `leads.status = 'no_show'` and incremented `no_show_count`, but
-- NOTHING moved `leads.stage_id` — so the lead sat in "Consultation Scheduled"
-- forever, visually identical to a patient whose appointment is still upcoming.
-- The no_show_rate KPI counted them correctly while the work queue stayed wrong,
-- which is the failure mode that hides longest.
--
-- This adds the column the front desk triages from each morning. It is an
-- OPERATIONAL stage (lib/pipeline/stage-groups.ts OPERATIONAL_STAGE_SLUGS), not
-- a funnel position, because:
--
--   • A no-show is not a point on the way to the close — the lead can rebook and
--     return to consultation-scheduled, or go quiet and decay to Nurturing.
--   • Operational columns count their TRUE population (no `status NOT IN
--     (disqualified, lost)` filter), which is what a triage queue needs.
--
-- Why not reuse Nurturing: the stage-mover's fallback regex
-- (/no.?show|re.?engage|nurtur/i) matches Nurturing when no no-show stage
-- exists, which would mix "worked, went cold" with "booked and ghosted". Those
-- cohorts need completely different recovery copy — see
-- lib/campaigns/no-show-recovery.ts vs. the engagement-sweep cool-down.
--
-- Idempotent + per-org: seeds every organization that has a pipeline, appending
-- above its max position. Same shape as 20260708120000_off_funnel_parking_stages.

insert into public.pipeline_stages
  (organization_id, name, slug, description, color, position, is_default, is_won, is_lost)
select
  o.organization_id,
  v.name,
  v.slug,
  v.description,
  v.color,
  o.maxpos + v.pos_offset,
  false, false, false
from (
  select organization_id, max(position) as maxpos
  from public.pipeline_stages
  group by organization_id
) o
cross join (values
  ('No-Show', 'no-show',
   'Booked a consultation and did not attend. Worked by the No-Show Recovery rebooking sequence; exits on reply or a new booking.',
   '#f97316', 1)
) as v(name, slug, description, color, pos_offset)
where not exists (
  select 1 from public.pipeline_stages ex
  where ex.organization_id = o.organization_id
    and ex.slug = v.slug
);
