-- Workstream D2: human task lane.
--
-- WHAT: a first-class queue of work allocated to HUMANS by the D1 allocation
-- resolver (automation_policies). When a policy says a human owns an inbound
-- reply / first touch / recommendation, the automation stands down and a row
-- lands here instead — with the AI's context (draft, detail) attached so the
-- human starts warm.
--
-- Distinct from `escalations` (AI tried and failed / was blocked); tasks are
-- work the AI never attempted because a human owns it by policy. D3 later uses
-- due_at for SLA takeover ('hold' → AI takes over → status 'taken_by_ai').
--
-- Dedupe: repeated triggers for the same unit of work (e.g. a lead texting
-- twice before staff reply) collapse into ONE open task via dedupe_key
-- ('inbound:<conversation_id>', 'first_touch:<lead_id>'), enforced by a
-- partial unique index over open/claimed rows.

create table public.human_tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  campaign_id uuid references public.campaigns(id) on delete set null,
  policy_id uuid references public.automation_policies(id) on delete set null,
  -- FK added later when pipeline_recommendations lands (C2); plain uuid for now.
  recommendation_id uuid,
  kind text not null check (kind in (
    'inbound_reply','first_touch','nurture_step','stage_automation','recommendation','sla_breach_review')),
  title text not null,
  detail text,
  -- The AI's suggested message/action, held for the human (never auto-sent).
  ai_draft text,
  assigned_to uuid references public.user_profiles(id) on delete set null,
  -- Role the task was routed to when no specific user matched (e.g. 'admin').
  assigned_role text,
  status text not null default 'open' check (status in (
    'open','claimed','done','expired','taken_by_ai','dismissed')),
  -- SLA deadline. Set when the allocation decision was 'hold' (human-first
  -- with an SLA before the AI may take over — D3 enforces the takeover).
  due_at timestamptz,
  claimed_by uuid references public.user_profiles(id),
  claimed_at timestamptz,
  completed_at timestamptz,
  -- Which system created the task ('allocation', 'recommendation_apply', ...).
  source text not null,
  dedupe_key text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One LIVE task per unit of work: a second trigger with the same dedupe_key
-- refreshes the existing open/claimed row instead of inserting a duplicate.
-- Completed/expired rows fall out of the index, so history is preserved.
create unique index human_tasks_live_dedupe_uniq
  on public.human_tasks (organization_id, dedupe_key)
  where status in ('open','claimed') and dedupe_key is not null;

-- Queue reads: org board sorted by SLA, and "my tasks" for the badge/lists.
create index human_tasks_org_status_due_idx
  on public.human_tasks (organization_id, status, due_at);
create index human_tasks_assignee_live_idx
  on public.human_tasks (assigned_to)
  where status in ('open','claimed');
create index human_tasks_lead_idx on public.human_tasks (lead_id);

create trigger set_human_tasks_updated_at
  before update on public.human_tasks
  for each row execute function public.handle_updated_at();

alter table public.human_tasks enable row level security;

-- RLS mirrors the standard org-scoped pattern: get_user_org_id() resolves an
-- agency_admin's entered (active) org, so managing a client org covers its rows.
create policy "Users can view human_tasks in their org" on public.human_tasks
  for select using (organization_id = get_user_org_id());
create policy "Users can insert human_tasks in their org" on public.human_tasks
  for insert with check (organization_id = get_user_org_id());
create policy "Users can update human_tasks in their org" on public.human_tasks
  for update using (organization_id = get_user_org_id());
create policy "Users can delete human_tasks in their org" on public.human_tasks
  for delete using (organization_id = get_user_org_id());
