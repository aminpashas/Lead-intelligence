-- Workstream D5: multi-channel staff notifications.
--
-- Three pieces:
--   1. push_subscriptions — Web Push (VAPID) endpoints per staff user. A user
--      may hold several (laptop + phone). Rows are pruned automatically when
--      a push returns 404/410 (see src/lib/notifications/web-push.ts).
--   2. notification_log — append-only ledger of every staff notification sent
--      (slack/sms/email/push). Drives the 10-minute per-(conversation, user,
--      channel) dedupe cooldown in src/lib/notifications/staff-notify.ts.
--      user_id is NULL for org-level channels (Slack posts to a channel, not
--      a person).
--   3. user_profiles.notification_prefs — per-user channel toggles, written
--      from Settings. Empty object = all channels on (default-on posture);
--      an explicit `{"sms": false}` opts that channel off.

-- ── 1. Push subscriptions ────────────────────────────────────────────
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.user_profiles(id) on delete cascade,
  -- The browser-issued push endpoint URL. Globally unique per subscription;
  -- re-subscribing the same browser upserts in place.
  endpoint text not null unique,
  -- { p256dh, auth } keys from PushSubscription.toJSON().
  keys jsonb not null default '{}'::jsonb,
  user_agent text,
  created_at timestamptz not null default now(),
  last_success_at timestamptz
);

create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

-- User-owns-row CRUD: subscriptions are personal device credentials, not org
-- data — only the owning user may read or manage them from the client. The
-- notifier reads them with the service-role client (bypasses RLS).
create policy "Users can view their own push subscriptions" on public.push_subscriptions
  for select using (user_id = auth.uid());
create policy "Users can insert their own push subscriptions" on public.push_subscriptions
  for insert with check (
    user_id = auth.uid()
    and organization_id = get_user_org_id()
  );
create policy "Users can update their own push subscriptions" on public.push_subscriptions
  for update using (user_id = auth.uid())
  with check (user_id = auth.uid());
create policy "Users can delete their own push subscriptions" on public.push_subscriptions
  for delete using (user_id = auth.uid());

-- ── 2. Notification log ──────────────────────────────────────────────
create table public.notification_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete cascade,
  -- NULL for org-level channels (Slack); a user id for per-person channels.
  user_id uuid references public.user_profiles(id) on delete cascade,
  channel text not null check (channel in ('slack', 'sms', 'email', 'push')),
  event_type text not null,
  sent_at timestamptz not null default now()
);

-- Cooldown lookups: recent sends for a conversation, filtered per user.
create index notification_log_cooldown_idx
  on public.notification_log (organization_id, conversation_id, user_id, sent_at desc);

alter table public.notification_log enable row level security;

-- Org members can read the ledger (audit surface); WRITES are service-role
-- only — no insert policy on purpose. All sends originate from server paths
-- (webhooks, escalation, crons) holding the service key.
create policy "Users can view notification_log in their org" on public.notification_log
  for select using (organization_id = get_user_org_id());

-- ── 3. Per-user channel prefs ────────────────────────────────────────
alter table public.user_profiles
  add column if not exists notification_prefs jsonb not null default '{}'::jsonb;
