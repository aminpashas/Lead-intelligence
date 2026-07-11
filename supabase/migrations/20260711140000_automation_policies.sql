-- Workstream D1: automation allocation policies (dormant by default).
--
-- WHAT: per-scope rules that decide WHO owns an automation touch — the AI, a
-- human, or hybrid (schedule-based) — plus an optional "human-first" hold with
-- an SLA before the AI is allowed to take over (SLA enforcement lands in D2/D3;
-- this migration + resolver only make the decision).
--
-- DORMANT SHIP: with zero rows in this table and the org-level toggle off, the
-- resolver returns owner='ai' (reason 'legacy_default') — exactly today's
-- behavior. Nothing changes for any org until a policy row is inserted or
-- organizations.human_first_sla_enabled is flipped on.

create table public.automation_policies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  scope text not null check (scope in ('org_default','campaign','stage','segment')),
  campaign_id uuid references public.campaigns(id) on delete cascade,
  voice_campaign_id uuid references public.voice_campaigns(id) on delete cascade,
  stage_id uuid references public.pipeline_stages(id) on delete cascade,
  smart_list_id uuid references public.smart_lists(id) on delete cascade,
  -- Which automation kinds this policy governs. Empty array = all kinds.
  -- Vocabulary: inbound_reply | speed_to_lead | nurture_step | stage_automation | recommendation
  kinds text[] not null default '{}',
  owner text not null default 'ai' check (owner in ('ai','human','hybrid')),
  ai_role text check (ai_role in ('setter','closer')),
  -- WeekSchedule shape (same as organizations.autopilot_schedule). For
  -- owner='hybrid': enabled days/hours are the HUMAN hours; outside them the AI owns.
  human_schedule jsonb,
  -- Human gets first crack: resolver returns owner='hold' with the SLA below.
  human_first boolean not null default false,
  human_response_sla_seconds int not null default 180 check (human_response_sla_seconds between 30 and 3600),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scope_target check (
    (scope='org_default' and campaign_id is null and stage_id is null and smart_list_id is null and voice_campaign_id is null)
    or (scope='campaign' and (campaign_id is not null or voice_campaign_id is not null))
    or (scope='stage' and stage_id is not null)
    or (scope='segment' and smart_list_id is not null))
);

-- One policy per target (per org for the default; per campaign/stage/segment otherwise).
create unique index automation_policies_org_default_uniq
  on public.automation_policies (organization_id)
  where scope = 'org_default';
create unique index automation_policies_campaign_uniq
  on public.automation_policies (campaign_id)
  where campaign_id is not null;
create unique index automation_policies_voice_campaign_uniq
  on public.automation_policies (voice_campaign_id)
  where voice_campaign_id is not null;
create unique index automation_policies_stage_uniq
  on public.automation_policies (stage_id)
  where stage_id is not null;
create unique index automation_policies_smart_list_uniq
  on public.automation_policies (smart_list_id)
  where smart_list_id is not null;

create index automation_policies_org_enabled_idx
  on public.automation_policies (organization_id)
  where enabled;

create trigger set_automation_policies_updated_at
  before update on public.automation_policies
  for each row execute function public.handle_updated_at();

alter table public.automation_policies enable row level security;

-- RLS mirrors the standard org-scoped pattern: get_user_org_id() resolves an
-- agency_admin's entered (active) org, so managing a client org covers its rows.
create policy "Users can view automation_policies in their org" on public.automation_policies
  for select using (organization_id = get_user_org_id());
create policy "Users can insert automation_policies in their org" on public.automation_policies
  for insert with check (organization_id = get_user_org_id());
create policy "Users can update automation_policies in their org" on public.automation_policies
  for update using (organization_id = get_user_org_id());
create policy "Users can delete automation_policies in their org" on public.automation_policies
  for delete using (organization_id = get_user_org_id());

-- Org-level fallback: when ON and no policy row matches, inbound replies are
-- HELD for a human for human_first_sla_seconds before the AI may take over.
-- Default OFF = dormant (today's behavior).
alter table public.organizations
  add column if not exists human_first_sla_enabled boolean not null default false,
  add column if not exists human_first_sla_seconds int not null default 180;
