-- Reconcile the legacy one-off "Follow Up" (slug 'follow-up') stage into the new
-- Following Up / Engaged / Nurturing scheme, then remove the now-redundant column.
--
-- Background: a prior consult-scheduled reality-guard parked stale residual leads
-- in a new LI 'follow-up' stage. No live code creates or feeds that stage
-- (reconcile-map maps the GHL name "follow-up" -> slug 'contacted', not here), so
-- once emptied it can be dropped permanently. This runs AFTER
-- 20260707120000 (which creates 'engaged' and ensures 'nurturing' exist).
--
-- Classification mirrors src/lib/pipeline/contacted-state.ts (ENGAGED_MAX_CADENCE_DAYS = 14),
-- identical to the 'contacted' backfill. Send-safe: only leads.stage_id + one
-- pipeline_stages delete. No messages. Idempotent: once 'follow-up' is gone the
-- per-org guard makes a re-run a no-op.

begin;

do $$
declare
  org record;
  fu_id uuid; contacted_id uuid; engaged_id uuid; nurturing_id uuid; lost_id uuid;
begin
  for org in select id from public.organizations loop
    select id into fu_id from public.pipeline_stages where organization_id = org.id and slug = 'follow-up';
    if fu_id is null then continue; end if; -- nothing to reconcile for this org

    select id into contacted_id from public.pipeline_stages where organization_id = org.id and slug = 'contacted';
    select id into engaged_id   from public.pipeline_stages where organization_id = org.id and slug = 'engaged';
    select id into nurturing_id from public.pipeline_stages where organization_id = org.id and slug = 'nurturing';
    select id into lost_id      from public.pipeline_stages where organization_id = org.id and slug = 'lost';

    -- Dead leads (disqualified/lost) -> Lost.
    if lost_id is not null then
      update public.leads set stage_id = lost_id
       where organization_id = org.id and stage_id = fu_id
         and status in ('disqualified','lost');
    end if;

    -- Replied -> Engaged. (Engaged runs before Nurturing so a replied-but-old lead is Engaged.)
    if engaged_id is not null then
      update public.leads set stage_id = engaged_id
       where organization_id = org.id and stage_id = fu_id
         and status not in ('disqualified','lost')
         and ( coalesce(total_messages_received,0) > 0
               or (last_responded_at is not null
                   and (last_contacted_at is null or last_responded_at >= last_contacted_at)) );
    end if;

    -- Silent past the 14-day cadence window -> Nurturing.
    if nurturing_id is not null then
      update public.leads set stage_id = nurturing_id
       where organization_id = org.id and stage_id = fu_id
         and status not in ('disqualified','lost')
         and last_contacted_at is not null
         and last_contacted_at < now() - interval '14 days';
    end if;

    -- Everything still on the legacy stage -> Following Up (contacted).
    if contacted_id is not null then
      update public.leads set stage_id = contacted_id
       where organization_id = org.id and stage_id = fu_id;
    end if;

    -- Drop the now-empty legacy stage (guarded: only if nothing references it).
    delete from public.pipeline_stages
     where id = fu_id
       and not exists (select 1 from public.leads where stage_id = fu_id);
  end loop;
end $$;

commit;
