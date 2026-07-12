-- Campaign-scoped AI: make a campaign carry its own AI behavior + send authorization.
--
-- ai_enabled      may the AI work leads enrolled in this campaign at all
-- autopilot_mode  per-campaign supervision: review_first (draft, human approves) | auto | off
-- send_mode       deny-by-default physical-send authorization: suppressed | live
-- playbook        goal/tone/hooks/guardrails injected into the agent prompt
--
-- Deny-by-default for NEW campaigns (defaults ai_enabled=false, send_mode=suppressed),
-- but backfill existing rows to send_mode=live so campaigns already running keep sending.
-- Replay-safe: add-column-if-not-exists guards + idempotent constraint drops.

alter table public.campaigns
  add column if not exists ai_enabled boolean not null default false,
  add column if not exists autopilot_mode text not null default 'review_first',
  add column if not exists send_mode text not null default 'suppressed',
  add column if not exists playbook jsonb not null default '{}'::jsonb;

alter table public.campaigns drop constraint if exists campaigns_autopilot_mode_check;
alter table public.campaigns
  add constraint campaigns_autopilot_mode_check
  check (autopilot_mode in ('review_first', 'auto', 'off'));

alter table public.campaigns drop constraint if exists campaigns_send_mode_check;
alter table public.campaigns
  add constraint campaigns_send_mode_check
  check (send_mode in ('suppressed', 'live'));

-- Preserve current behavior for campaigns that already existed before this migration.
update public.campaigns set send_mode = 'live' where send_mode = 'suppressed';

-- Review queue for review_first campaigns: AI drafts a message, a human approves before it sends.
create table if not exists public.campaign_review_drafts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  conversation_id uuid,
  channel text not null check (channel in ('sms', 'email')),
  subject text,
  body text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references public.user_profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_campaign_review_drafts_pending
  on public.campaign_review_drafts (organization_id, status)
  where status = 'pending';

alter table public.campaign_review_drafts enable row level security;

drop policy if exists campaign_review_drafts_org on public.campaign_review_drafts;
create policy campaign_review_drafts_org on public.campaign_review_drafts
  for all using (organization_id = public.get_user_org_id())
  with check (organization_id = public.get_user_org_id());
