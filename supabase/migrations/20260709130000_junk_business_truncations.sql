-- Extend the junk pass of reclassify_off_funnel_contacts (mirrors BUSINESS_KEYWORDS
-- + BUSINESS_TRUNCATIONS in lib/leads/junk-contact.ts):
--   • add the standalone professional suffixes `dds` / `dmd` (whole word) — the
--     most common other-practice caller ("Brattesani Dds", "Tim Choy Dmd").
--   • add the WhatConverts ~15-char CLIP: a dental office / professional lands
--     truncated as "Lake Merced Den" (Dental) or "Lum Darwin F Dd" (DDS). A
--     trailing " den" / " dd" token is that clipped suffix, never a real surname.
-- Supersedes 20260709090000 (business keywords). CREATE OR REPLACE — idempotent.

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
  v_existing uuid;
  v_junk uuid;
  v_ep integer := 0;
  v_jk integer := 0;
  us_states text[] := array['al','ak','az','ar','ca','co','ct','de','fl','ga','hi',
    'id','il','in','ia','ks','ky','la','me','md','ma','mi','mn','ms','mo','mt','ne',
    'nv','nh','nj','nm','ny','nc','nd','oh','ok','or','pa','ri','sc','sd','tn','tx',
    'ut','vt','va','wa','wv','wi','wy','dc','pr','vi','gu','as','mp'];
  placeholders text[] := array['unknown','anonymous','restricted','private',
    'unavailable','no name','wireless caller','wireless','cell phone','toll free',
    'tollfree','spam','spam risk','scam likely','potential spam','v mail','voicemail',
    'no caller id','name unavailable','unknown caller','unknown name','out of area'];
  biz_re text := '\y(dental|dentist|dentistry|orthodont\w*|endodont\w*|periodont\w*|prosthodont\w*|invisalign|pharmacy|clinic|hospital|medical|medicaid|medicare|insurance|kaiser permanen\w*|aetna|cigna|metlife|humana|anthem|delta ?dental|unitedhealth\w*|healthplan|health plan|dds|dmd|llc|inc)\y';
  trunc_re text := ' (den|dd)$';
  call_sources text[] := array['whatconverts','voice','callrail'];
begin
  select id into v_new      from pipeline_stages where organization_id = p_org and slug = 'new'              limit 1;
  select id into v_existing from pipeline_stages where organization_id = p_org and slug = 'existing-patient' limit 1;
  select id into v_junk     from pipeline_stages where organization_id = p_org and slug = 'junk'             limit 1;
  if v_new is null or v_existing is null or v_junk is null then
    return query select 0, 0;
    return;
  end if;

  with cand as (
    select distinct on (l.id) l.id, p.id as patient_id,
           case when l.email_hash is not null and p.email_hash = l.email_hash
                then 'email_hash' else 'phone_hash' end as match_method
    from leads l
    join patients p
      on p.organization_id = l.organization_id
     and ( (l.email_hash is not null and p.email_hash = l.email_hash)
        or (l.phone_hash is not null and p.phone_hash = l.phone_hash) )
    where l.organization_id = p_org
      and l.stage_id = v_new
      and l.source_type = any(call_sources)
      and l.is_existing_patient = false
    order by l.id, match_method
    limit p_limit
  ),
  upd as (
    update leads l
       set stage_id = v_existing, is_existing_patient = true, matched_patient_id = c.patient_id
      from cand c
     where l.id = c.id
    returning l.id, c.patient_id, c.match_method
  ),
  link as (
    update patients p set lead_id = u.id
      from upd u
     where p.id = u.patient_id and p.lead_id is null
    returning 1
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

  with cand as (
    select l.id
      from leads l
      cross join lateral (
        select btrim(lower(coalesce(l.first_name,'') || ' ' || coalesce(l.last_name,''))) as nm
      ) n
      cross join lateral (select regexp_split_to_array(n.nm, '\s+') as toks) x
     where l.organization_id = p_org
       and l.stage_id = v_new
       and l.source_type = any(call_sources)
       and l.is_existing_patient = false
       and (l.email is null or l.email = '')
       and l.phone_valid is not true
       and (
         n.nm = any(placeholders)
         or lower(btrim(coalesce(l.first_name,''))) = any(placeholders)
         or (
           array_length(x.toks, 1) between 2 and 3
           and x.toks[array_length(x.toks, 1)] = any(us_states)
         )
         or n.nm ~* biz_re
         or n.nm ~ trunc_re
       )
     limit p_limit
  ),
  upd as (
    update leads l set stage_id = v_junk, status = 'disqualified'
      from cand c
     where l.id = c.id
    returning l.id
  )
  select count(*)::int into v_jk from upd;

  return query select v_ep, v_jk;
end;
$$;
