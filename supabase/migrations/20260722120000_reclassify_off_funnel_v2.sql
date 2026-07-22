-- Off-funnel reclassifier v2 — un-break the drift sweep
-- =====================================================
-- The v1 RPC (20260708122000) returned 0 rows on EVERY hourly run for weeks.
-- Two predicates had silently gone stale:
--
--   1. `stage_id = 'new'` — since the paid-only intake gate shipped, brand-new
--      leads land in `no-communication`, not `new`. The `new` stage holds 3
--      leads org-wide. The sweep was looking at an empty room.
--
--   2. `source_type in ('whatconverts','voice','callrail')` — GHL is now the
--      dominant capture source. 523 of the 557 identifiable existing patients
--      sitting in un-worked stages are `gohighlevel` / `ghl_import`, i.e. every
--      one of them was excluded by the allowlist.
--
-- A cron that returns `ok / 0 items` reads as "nothing to do". It was actually
-- "asking the wrong question". Both predicates are fixed here.
--
-- THREE PASSES, deliberately different in blast radius:
--
--   A. FLAG (all stages, all sources) — set is_existing_patient + the patient
--      bridge, WITHOUT moving the lead. This is the pass campaign targeting and
--      the smart-list filters actually need, and it is non-destructive: an
--      existing patient enquiring about NEW treatment is still a real
--      opportunity ("flag but keep", per the original reconciliation design).
--
--   B. MOVE (un-worked stages only: new + no-communication) — park in the
--      `existing-patient` stage and hand off to Dion Desk. Scoped to un-worked
--      queues so a worked or won deal can never be yanked out of the funnel.
--      This is why `nurturing` / `consultation-completed` are NOT swept even
--      though ~1,200 matched leads sit there: those are worked opportunities.
--
--   C. JUNK (un-worked stages, CALL sources only) — unchanged heuristic. Kept
--      call-scoped on purpose: the name-shape rules are tuned on caller-ID
--      strings, and applying them to form/social display names would be a new
--      class of false positive. Mirrors lib/leads/junk-contact.ts.
--
-- PERFORMANCE: v1 joined leads↔patients with `(email_hash = .. OR phone_hash = ..)`.
-- Postgres cannot use an index for an OR-join, so it hash-joined 83k patients
-- against the lead table — fine when bounded to a 3-row stage, fatal once the
-- scope widens (the equivalent query times out in the SQL editor). Both hash
-- passes below are split into separate index-friendly EXISTS probes against
-- idx_patients_email_hash / idx_patients_phone_hash.

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

  -- Un-worked queues. `new` survives for orgs that never adopted the paid-only
  -- intake gate; `no-communication` is where gated orgs actually land leads.
  v_unworked := array_remove(array[v_new, v_nocomm], null);
  if array_length(v_unworked, 1) is null then
    return query select 0, 0;
    return;
  end if;

  -- ---------------------------------------------------------------- PASS A
  -- Flag-only. No stage change, no Desk hand-off — just make the lead
  -- filterable so campaign targeting and smart lists can exclude it.
  -- NOTE the limit placement: it must come AFTER the match filter, not before.
  -- Limiting the candidate scan instead would re-examine the same non-matching
  -- leads every hour and never reach the matches behind them — the sweep would
  -- run forever without converging.
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

  -- ---------------------------------------------------------------- PASS B
  -- Move + hand off, un-worked stages only. Reads the flag Pass A just set, so
  -- it is source-agnostic by construction.
  --
  -- Three independent tests must all agree before a lead is pulled from the
  -- funnel, because each one alone has a known failure mode:
  --
  --   • un-worked STAGE  — but stage and status drift: 65 leads sit in an
  --     un-worked stage carrying consultation_completed / _scheduled.
  --   • un-worked STATUS — covers that drift.
  --   • a PRIOR VISIT    — the mirror match alone is not evidence of an
  --     established patient. CareStack creates the record at BOOKING, so a
  --     prospect who books gets one immediately; 115 of the 515 matching
  --     un-worked leads have no visit history at all. Those stay in the funnel
  --     (still flagged by Pass A, so campaigns decline them).
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

  -- ---------------------------------------------------------------- PASS C
  -- Junk: phone not confirmed valid, no email, name is caller-ID noise.
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
  'v2. Flags ALL hash-matched existing patients (any stage/source, non-destructive), MOVES only those in un-worked stages (new + no-communication) into the existing-patient parking stage with a Desk hand-off, and parks caller-ID junk. Index-friendly EXISTS probes, batch-limited, idempotent.';
