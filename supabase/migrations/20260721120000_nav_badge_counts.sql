-- Sidebar notification-badge counts (iPhone/macOS-style unread badges).
--
-- One round-trip for every count the left nav shows, computed server-side so the
-- badges can never drift from the pages they point at. Each count is the
-- *outstanding work* on that surface — it drops as the work is actually done
-- (a reply sent, a call returned, a lead contacted, an appointment confirmed),
-- NOT when the section is merely opened.
--
-- Definitions reuse the app's existing canonical signals verbatim:
--   • tasks         — open+claimed human_tasks (same as /api/tasks openCount)
--   • conversations — newest message on the thread is inbound within 30d
--                     (same signal as conversations_awaiting_reply / the
--                     dashboard "Needs Reply"; conversations.unread_count is
--                     deliberately NOT used — it is drift-prone, see that fn)
--   • call_center   — inbound voicemails + missed calls we haven't returned yet
--                     (the lead has not been contacted since the call landed)
--   • leads         — genuinely NEW arrivals: never-contacted, non-junk leads
--                     captured in the last 48h. This is a notification, not the
--                     whole untouched backlog (which is thousands of stale rows
--                     and belongs on the Leads page / Smart Lists, never on a
--                     badge that would then read "99+" forever).
--   • appointments  — upcoming, still-unconfirmed appointments (next 7 days)
--
-- STABLE + pinned search_path and deliberately NOT security definer, so the
-- caller's RLS scopes every row to their org — same shape as
-- conversations_awaiting_reply and pipeline_stage_counts.
create or replace function public.nav_badge_counts(p_org uuid)
returns table (
  tasks integer,
  conversations integer,
  call_center integer,
  leads integer,
  appointments integer
)
language sql
stable
set search_path to 'public', 'pg_temp'
as $function$
  select
    -- Open work in the task queue.
    (
      select count(*)::int
      from public.human_tasks ht
      where ht.organization_id = p_org
        and ht.status in ('open', 'claimed')
    ),
    -- Threads where the patient spoke last and we haven't answered (30-day
    -- window). Derived from the messages themselves so it cannot drift.
    (
      with latest as (
        select distinct on (m.conversation_id)
          m.conversation_id,
          m.direction
        from public.messages m
        where m.organization_id = p_org
          and m.created_at >= now() - interval '30 days'
        order by m.conversation_id, m.created_at desc
      )
      select count(*)::int
      from latest
      join public.conversations c on c.id = latest.conversation_id
      where latest.direction = 'inbound'
        and c.organization_id = p_org
        and c.status <> 'archived'
    ),
    -- Inbound voicemails + missed calls not yet returned: the lead has had no
    -- contact since the call landed (last 30 days).
    (
      select count(*)::int
      from public.voice_calls vc
      join public.leads l on l.id = vc.lead_id
      where vc.organization_id = p_org
        and vc.direction = 'inbound'
        and vc.outcome in ('voicemail_received', 'no_answer')
        and vc.created_at >= now() - interval '30 days'
        and (l.last_contacted_at is null or l.last_contacted_at < vc.created_at)
    ),
    -- Genuinely new arrivals: never contacted, not junk, captured in the last
    -- 48h. Ages out on its own AND drops the moment the lead is worked.
    (
      select count(*)::int
      from public.leads l
      where l.organization_id = p_org
        and l.last_contacted_at is null
        and l.status::text not in ('disqualified', 'completed')
        and l.created_at >= now() - interval '48 hours'
    ),
    -- Upcoming appointments still awaiting confirmation (next 7 days).
    -- 'confirmed' is already confirmed; 'pending_card' is not a real booking.
    (
      select count(*)::int
      from public.appointments a
      where a.organization_id = p_org
        and a.status = 'scheduled'
        and a.confirmation_received = false
        and a.scheduled_at >= now()
        and a.scheduled_at < now() + interval '7 days'
    );
$function$;

comment on function public.nav_badge_counts(uuid) is
  'Outstanding-work counts for the left-nav notification badges (tasks, conversations awaiting reply, unreturned voicemails/missed calls, new leads, unconfirmed upcoming appointments). RLS-scoped to the caller''s org.';
