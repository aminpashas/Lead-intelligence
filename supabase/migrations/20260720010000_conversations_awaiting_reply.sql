-- Conversations where the patient spoke last and we haven't answered.
--
-- The dashboard's "unread" rail keyed on conversations.unread_count, which is
-- only ever *cleared* (set to 0 when a thread is opened) and is incremented only
-- on the Twilio webhook path. Nearly all conversation volume arrives via the GHL
-- ingest, which never increments it — so the rail matched 35 threads, 34 of them
-- stale backfill artifacts from 2025, while hundreds of live threads awaiting a
-- reply stayed invisible.
--
-- "Awaiting reply" is derived from the messages themselves rather than a
-- counter, so it cannot drift: the newest message on the thread is inbound.
--
-- STABLE + pinned search_path, and deliberately NOT security definer, so the
-- caller's RLS still scopes rows to their org (same shape as
-- pipeline_stage_counts). p_since bounds the scan; callers pass a window rather
-- than scanning all history.
--
-- Name columns come back encrypted (enc::) exactly as a PostgREST select would;
-- the caller decrypts server-side via decryptLeadsPII.
create or replace function public.conversations_awaiting_reply(
  p_org uuid,
  p_since timestamptz
)
returns table (
  id uuid,
  lead_id uuid,
  channel text,
  last_message_at timestamptz,
  last_message_preview text,
  unread_count integer,
  first_name text,
  last_name text
)
language sql
stable
set search_path to 'public', 'pg_temp'
as $function$
  with latest as (
    -- One row per conversation: its most recent message in the window.
    select distinct on (m.conversation_id)
      m.conversation_id,
      m.direction
    from public.messages m
    where m.organization_id = p_org
      and m.created_at >= p_since
    order by m.conversation_id, m.created_at desc
  )
  select
    c.id,
    c.lead_id,
    c.channel,
    c.last_message_at,
    c.last_message_preview,
    c.unread_count,
    l.first_name,
    l.last_name
  from latest
  join public.conversations c on c.id = latest.conversation_id
  left join public.leads l on l.id = c.lead_id
  where latest.direction = 'inbound'
    and c.organization_id = p_org
  order by c.last_message_at desc;
$function$;

comment on function public.conversations_awaiting_reply(uuid, timestamptz) is
  'Conversations whose newest message in the window is inbound — i.e. the patient is waiting on us. Replaces the drift-prone conversations.unread_count as the dashboard "needs attention" signal.';
