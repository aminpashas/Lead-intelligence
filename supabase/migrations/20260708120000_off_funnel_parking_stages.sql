-- Off-funnel parking stages
-- =========================
-- Inbound call-tracking (WhatConverts) creates a "New Lead" for EVERY caller,
-- including existing patients and caller-ID noise (city/state strings, carrier
-- placeholders). Those are not sales leads. This adds two parking stages the
-- ingestion reorder routes non-leads into instead of the default "New Lead":
--
--   • existing-patient — matches the CareStack patient mirror (owned by Dion
--     Desk per the ecosystem matrix; parked here until Desk can receive it).
--   • junk             — caller-ID noise with no reachable contact.
--
-- Both are hidden from the sales /pipeline and the default /leads view via
-- lib/pipeline/stage-groups.ts (OFF_FUNNEL_STAGE_SLUGS). Idempotent + per-org:
-- seeds every organization that has a pipeline, appending above its max position.

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
  ('Existing Patient', 'existing-patient',
   'Inbound contact matching an existing CareStack patient — front-desk / Dion Desk workflow, not a sales lead.',
   '#64748b', 1),
  ('Junk / Spam', 'junk',
   'Caller-ID noise (city/state strings, carrier placeholders) with no reachable contact — not a lead.',
   '#9ca3af', 2)
) as v(name, slug, description, color, pos_offset)
where not exists (
  select 1 from public.pipeline_stages ex
  where ex.organization_id = o.organization_id
    and ex.slug = v.slug
);
