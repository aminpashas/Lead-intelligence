-- Migration 011: Sales Technique Tracking & Lead Engagement Assessment
-- Tracks which sales techniques the AI agents use per message,
-- real-time lead engagement assessments, and conversation-level summaries.

-- ═══════════════════════════════════════════════════════════════
-- 1. MESSAGE TECHNIQUE TRACKING
-- ═══════════════════════════════════════════════════════════════

create table public.message_technique_tracking (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  message_index integer not null,
  agent_type text not null check (agent_type in ('setter', 'closer')),
  technique_id text not null,
  technique_category text not null,
  technique_confidence numeric(3,2) check (technique_confidence between 0 and 1),
  predicted_effectiveness text check (predicted_effectiveness in ('effective','neutral','backfired','too_early')),
  actual_effectiveness text check (actual_effectiveness in ('effective','neutral','backfired','too_early')),
  context_note text,
  created_at timestamptz default now()
);

create index idx_mtt_org on message_technique_tracking(organization_id, created_at desc);
create index idx_mtt_conv on message_technique_tracking(conversation_id);
create index idx_mtt_lead on message_technique_tracking(lead_id);
create index idx_mtt_technique on message_technique_tracking(organization_id, technique_id);

alter table message_technique_tracking enable row level security;
create policy "mtt_org_access" on message_technique_tracking
  for all using (organization_id = public.get_user_org_id());

-- ═══════════════════════════════════════════════════════════════
-- 2. LEAD ENGAGEMENT ASSESSMENTS
-- ═══════════════════════════════════════════════════════════════

create table public.lead_engagement_assessments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  message_index integer not null,
  engagement_temperature integer check (engagement_temperature between 1 and 10),
  resistance_level integer check (resistance_level between 1 and 10),
  buying_readiness integer check (buying_readiness between 1 and 10),
  emotional_state text,
  recommended_approach text,
  techniques_to_try_next jsonb default '[]'::jsonb,
  techniques_to_avoid jsonb default '[]'::jsonb,
  created_at timestamptz default now()
);

create index idx_lea_org on lead_engagement_assessments(organization_id, created_at desc);
create index idx_lea_conv on lead_engagement_assessments(conversation_id);
create index idx_lea_lead on lead_engagement_assessments(lead_id);

alter table lead_engagement_assessments enable row level security;
create policy "lea_org_access" on lead_engagement_assessments
  for all using (organization_id = public.get_user_org_id());

-- ═══════════════════════════════════════════════════════════════
-- 3. CONVERSATION TECHNIQUE SUMMARIES
-- ═══════════════════════════════════════════════════════════════

create table public.conversation_technique_summaries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null unique references public.conversations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  total_techniques_used integer default 0,
  unique_techniques_used integer default 0,
  techniques_breakdown jsonb default '{}'::jsonb,
  category_breakdown jsonb default '{}'::jsonb,
  most_effective_technique text,
  technique_diversity_score numeric(3,2) default 0 check (technique_diversity_score between 0 and 1),
  approach_adaptation_score numeric(3,2) default 0 check (approach_adaptation_score between 0 and 1),
  final_engagement_temperature integer,
  final_buying_readiness integer,
  engagement_trend text check (engagement_trend in ('improving','stable','declining')),
  updated_at timestamptz default now(),
  created_at timestamptz default now()
);

create index idx_cts_org on conversation_technique_summaries(organization_id);
create index idx_cts_lead on conversation_technique_summaries(lead_id);

alter table conversation_technique_summaries enable row level security;
create policy "cts_org_access" on conversation_technique_summaries
  for all using (organization_id = public.get_user_org_id());

-- Updated_at triggers
create trigger mtt_updated_at before update on conversation_technique_summaries
  for each row execute function update_updated_at_column();
