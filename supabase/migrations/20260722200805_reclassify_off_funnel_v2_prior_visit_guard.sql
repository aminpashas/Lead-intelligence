-- Off-funnel reclassifier v2 — prior-visit guard (DRIFT RECONCILIATION)
-- ======================================================================
-- This file did not exist in the repo. It is captured verbatim from
-- supabase_migrations.schema_migrations version 20260722200805, which was
-- applied directly to production. Two refinements were applied to prod after
-- the base v2 migration and neither had a local file:
--
--   20260722194930  reclassify_off_funnel_v2_status_guard
--   20260722200805  reclassify_off_funnel_v2_prior_visit_guard   <- this one
--
-- Both are `create or replace` of the SAME function, so this final one fully
-- supersedes the intermediate; replaying the repo in filename order
-- (20260722120000 base -> this) reproduces the live definition. The
-- intermediate is deliberately not re-created as a file.
--
-- WHY THIS MATTERS: without this file, replaying migrations onto a fresh
-- database produced the base v2 function WITHOUT the prior-visit guard — and
-- re-applying the base v2 file over prod would have REGRESSED the live
-- function, un-parking the guard. The repo was behind prod, not ahead of it.
--
-- THE GUARD ITSELF: PASS B now additionally requires a visit that predates the
-- lead. CareStack creates the patient record at BOOKING, so a bare mirror match
-- is not evidence of an established patient — without this, a prospect who
-- booked through LI would be parked out of the funnel on their next touch.

create or replace function public.reclassify_off_funnel_contacts(
  p_org uuid,
  p_limit integer default 1000
)
returns table(existing_patient_moved integer, junk_moved integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new uuid;
  v_nocomm uuid;
  v_existing uuid;
  v_junk uuid;
  v_ep integer := 0;
  v_jk integer := 0;
  v_unworked uuid[];
  us_states text[] := array['al','ak','az','ar','ca','co','ct','de','fl','ga','hi',
    'id','il','in','ia','ks','ky','la','me','md','ma','mi','mn','ms','mo','mt','ne',
    'nv','nh','nj','nm','ny','nc','nd','oh','ok','or','pa','ri','sc','sd','tn','tx',
    'ut','vt','va','wa','wv','wi','wy','dc','pr','vi','gu','as','mp'];
  placeholders text[] := array['unknown','anonymous','restricted','private',
    'unavailable','no name','wireless caller','wireless','cell phone','toll free',
    'tollfree','spam','spam risk','scam likely','potential spam','v mail','voicemail',
    'no caller id','name unavailable','unknown caller','unknown name','out of area'];
  call_sources text[] := array['whatconverts','voice','callrail'];
begin
  select id into v_new      from pipeline_stages where organization_id = p_org and slug = 'new'              limit 1;
  select id into v_nocomm   from pipeline_stages where organization_id = p_org and slug = 'no-communication' limit 1;
  select id into v_existing from pipeline_stages where organization_id = p_org and slug = 'existing-patient' limit 1;
  select id into v_junk     from pipeline_stages where organization_id = p_org and slug = 'junk'             limit 1;
  if v_existing is null or v_junk is null then
    return query select 0, 0;
    return;
  end if;

  v_unworked := array_remove(array[v_new, v_nocomm], null);
  if array_length(v_unworked, 1) is null then
    return query select 0, 0;
    return;
  end if;

  -- PASS A: flag-only, all stages/sources, non-destructive.
  with probe as (
    select l.id,
           coalesce(
             (select p.id from patients p
               where p.organization_id = l.organization_id
                 and p.email_hash is not null and p.email_hash = l.email_hash
               limit 1),
             (select p.id from patients p
               where p.organization_id = l.organization_id
                 and p.phone_hash is not null and p.phone_hash = l.phone_hash
               limit 1)
           ) as patient_id
      from leads l
     where l.organization_id = p_org
       and l.is_existing_patient = false
       and (l.email_hash is not null or l.phone_hash is not null)
  ),
  hit as (
    select id, patient_id from probe where patient_id is not null limit p_limit
  ),
  upd as (
    update leads l
       set is_existing_patient = true, matched_patient_id = h.patient_id
      from hit h
     where l.id = h.id
    returning l.id, h.patient_id
  )
  update patients p set lead_id = u.id
    from upd u
   where p.id = u.patient_id and p.lead_id is null;

  -- PASS B: move + Desk hand-off. Requires un-worked stage AND un-worked status
  -- AND a visit predating the lead (CareStack registers at booking, so a mirror
  -- match alone is not evidence of an established patient).
  with cand as (
    select l.id, l.matched_patient_id as patient_id,
           case when l.email_hash is not null then 'email_hash' else 'phone_hash' end as match_method
      from leads l
     where l.organization_id = p_org
       and l.stage_id = any(v_unworked)
       and l.status = 'new'
       and l.is_existing_patient = true
       and l.matched_patient_id is not null
       and exists (
         select 1 from ehr_appointments a
          where a.patient_id = l.matched_patient_id
            and a.start_at < l.created_at
       )
     limit p_limit
  ),
  upd as (
    update leads l
       set stage_id = v_existing, stage_changed_at = now()
      from cand c
     where l.id = c.id
    returning l.id, c.patient_id, c.match_method
  ),
  enqueue as (
    insert into dion_desk_outbox
      (organization_id, lead_id, patient_id, event_type, idempotency_key, payload)
    select p_org, u.id, u.patient_id, 'comms.contact_identified',
           u.id || ':comms.contact_identified',
           jsonb_build_object('channel','inbound_call','matchMethod',u.match_method,'sourceType',null)
      from upd u
    on conflict (idempotency_key) do nothing
    returning 1
  )
  select count(*)::int into v_ep from upd;

  -- PASS C: junk, un-worked stages, call sources only.
  with cand as (
    select l.id
      from leads l
      cross join lateral (
        select regexp_split_to_array(
          btrim(lower(coalesce(l.first_name,'') || ' ' || coalesce(l.last_name,''))), '\s+'
        ) as toks
      ) x
     where l.organization_id = p_org
       and l.stage_id = any(v_unworked)
       and l.source_type = any(call_sources)
       and l.is_existing_patient = false
       and (l.email is null or l.email = '')
       and l.phone_valid is not true
       and (
         btrim(lower(coalesce(l.first_name,'') || ' ' || coalesce(l.last_name,''))) = any(placeholders)
         or lower(btrim(coalesce(l.first_name,''))) = any(placeholders)
         or (
           array_length(x.toks, 1) between 2 and 3
           and x.toks[array_length(x.toks, 1)] = any(us_states)
         )
       )
     limit p_limit
  ),
  upd as (
    update leads l set stage_id = v_junk, status = 'disqualified', stage_changed_at = now()
      from cand c
     where l.id = c.id
    returning l.id
  )
  select count(*)::int into v_jk from upd;

  return query select v_ep, v_jk;
end;
$$;

comment on function public.reclassify_off_funnel_contacts(uuid, integer) is
  'v2. Flags ALL hash-matched existing patients (any stage/source, non-destructive). MOVES only leads un-worked by stage AND status AND carrying a visit that predates the lead — CareStack registers at booking, so a mirror match alone is not evidence of an established patient. Index-friendly EXISTS probes, batch-limited, idempotent.';
