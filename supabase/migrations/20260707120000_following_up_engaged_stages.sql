-- Following Up + Engaged: split the "Contacted" funnel into two real board states.
-- Send-safe: only pipeline_stages rows and leads.stage_id are touched. No messages.
-- Classification thresholds MIRROR src/lib/pipeline/contacted-state.ts (ENGAGED_MAX_CADENCE_DAYS = 14).

begin;

-- 1) Rename display name of the existing 'contacted' stage. Slug UNCHANGED so all
--    existing leads and all GHL name->'contacted' mappings keep working untouched.
update public.pipeline_stages set name = 'Following Up' where slug = 'contacted';

-- 2) Insert 'engaged' per org right after Following Up; ensure 'nurturing' exists.
do $$
declare org record; contacted_pos integer;
begin
  for org in select id from public.organizations loop
    select position into contacted_pos
      from public.pipeline_stages where organization_id = org.id and slug = 'contacted';
    if contacted_pos is null then continue; end if;

    -- Guard the renumber AND the engaged insert together: on a re-run 'engaged'
    -- already exists, so this whole block no-ops and positions never shift again.
    if not exists (select 1 from public.pipeline_stages
                   where organization_id = org.id and slug = 'engaged') then
      update public.pipeline_stages set position = position + 1
        where organization_id = org.id and position > contacted_pos;

      insert into public.pipeline_stages (organization_id, name, slug, color, position, is_default)
      values (org.id, 'Engaged', 'engaged', '#10B981', contacted_pos + 1, false);
    end if;

    insert into public.pipeline_stages (organization_id, name, slug, color, position, is_default)
    select org.id, 'Nurturing', 'nurturing', '#8B8B8B',
           (select coalesce(max(position),0)+1 from public.pipeline_stages where organization_id = org.id), false
     where not exists (select 1 from public.pipeline_stages where organization_id = org.id and slug = 'nurturing');
  end loop;
end $$;

-- 3) Backfill existing 'contacted' leads into engaged/nurturing. Engaged runs FIRST
--    so a replied-but-old lead is Engaged, not Nurturing. Won/lost excluded.
do $$
declare org record; contacted_id uuid; engaged_id uuid; nurturing_id uuid;
begin
  for org in select id from public.organizations loop
    select id into contacted_id from public.pipeline_stages where organization_id = org.id and slug = 'contacted';
    select id into engaged_id   from public.pipeline_stages where organization_id = org.id and slug = 'engaged';
    select id into nurturing_id from public.pipeline_stages where organization_id = org.id and slug = 'nurturing';
    if contacted_id is null then continue; end if;

    update public.leads l set stage_id = engaged_id
     where l.organization_id = org.id and l.stage_id = contacted_id
       and engaged_id is not null
       and l.status not in ('disqualified','lost')
       and ( coalesce(l.total_messages_received,0) > 0
             or (l.last_responded_at is not null
                 and (l.last_contacted_at is null or l.last_responded_at >= l.last_contacted_at)) );

    update public.leads l set stage_id = nurturing_id
     where l.organization_id = org.id and l.stage_id = contacted_id
       and nurturing_id is not null
       and l.status not in ('disqualified','lost')
       and l.last_contacted_at is not null
       and l.last_contacted_at < now() - interval '14 days';
  end loop;
end $$;

-- 4) Update the seed trigger so NEW orgs get Following Up + Engaged from birth.
--    Every other stage from the original seed (New Lead, Qualified, Consultation
--    Scheduled/Completed, Treatment Presented, Financing, Contract Signed,
--    Scheduled for Treatment, Completed, Lost) is preserved verbatim; only
--    'contacted' is renamed to 'Following Up' and a new 'Engaged' row is inserted
--    immediately after it, with every later position shifted by one.
create or replace function public.seed_default_pipeline_stages()
returns trigger as $$
begin
  insert into public.pipeline_stages (organization_id, name, slug, color, position, is_default) values
    (new.id, 'New Lead', 'new', '#3B82F6', 0, true),
    (new.id, 'Following Up', 'contacted', '#8B5CF6', 1, false),
    (new.id, 'Engaged', 'engaged', '#10B981', 2, false),
    (new.id, 'Qualified', 'qualified', '#F59E0B', 3, false),
    (new.id, 'Consultation Scheduled', 'consultation-scheduled', '#10B981', 4, false),
    (new.id, 'Consultation Completed', 'consultation-completed', '#06B6D4', 5, false),
    (new.id, 'Treatment Presented', 'treatment-presented', '#EC4899', 6, false),
    (new.id, 'Financing', 'financing', '#F97316', 7, false),
    (new.id, 'Contract Signed', 'contract-signed', '#14B8A6', 8, false),
    (new.id, 'Scheduled for Treatment', 'scheduled', '#6366F1', 9, false);

  insert into public.pipeline_stages (organization_id, name, slug, color, position, is_won) values
    (new.id, 'Completed', 'completed', '#22C55E', 10, true);

  insert into public.pipeline_stages (organization_id, name, slug, color, position, is_lost) values
    (new.id, 'Lost', 'lost', '#EF4444', 11, true);

  return new;
end;
$$ language plpgsql;

commit;
