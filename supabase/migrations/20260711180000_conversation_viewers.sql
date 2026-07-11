-- Workstream D4: conversation presence.
--
-- WHAT: a heartbeat table recording which staff user currently has which
-- conversation thread open (mirrors the voice_agent_presence pattern from
-- 20260703190000_voice_live_transfer.sql). The thread UI POSTs a heartbeat
-- every ~30s while visible; a user counts as "viewing" when their
-- last_seen_at is within the freshness window (default 75s — two missed
-- beats) checked in src/lib/automation/presence.ts.
--
-- WHY: D5 staff notifications suppress pings to users who are already
-- looking at the conversation, and dedupe cooldowns reset once the user has
-- actually viewed the thread since the last notification.
--
-- Rows are upserted in place (PK conversation_id+user_id), so the table stays
-- tiny: one row per (conversation, user) pair ever opened.

create table public.conversation_viewers (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.user_profiles(id) on delete cascade,
  last_seen_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

-- Presence reads: "who is viewing conversation X right now" — scan newest first.
create index conversation_viewers_convo_seen_idx
  on public.conversation_viewers (conversation_id, last_seen_at desc);

alter table public.conversation_viewers enable row level security;

-- Org-scoped reads (anyone in the org can see who's on a thread — used by the
-- notifier and, later, "X is viewing" UI affordances).
create policy "Users can view conversation_viewers in their org" on public.conversation_viewers
  for select using (organization_id = get_user_org_id());

-- Heartbeats: a user may only write/refresh THEIR OWN presence row, and only
-- inside their active org (agency admins acting in a client org resolve via
-- get_user_org_id(), same as every other org-scoped table).
create policy "Users can insert their own presence row" on public.conversation_viewers
  for insert with check (
    organization_id = get_user_org_id()
    and user_id = auth.uid()
  );

create policy "Users can update their own presence row" on public.conversation_viewers
  for update using (user_id = auth.uid())
  with check (
    organization_id = get_user_org_id()
    and user_id = auth.uid()
  );
