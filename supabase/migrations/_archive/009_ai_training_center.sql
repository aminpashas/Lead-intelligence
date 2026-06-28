-- Migration 009: AI Training Center
-- Adds tables for AI memory (training instructions), knowledge base articles,
-- and saved test conversations for the playground.

-- ═══════════════════════════════════════════════════════════════
-- 1. AI MEMORIES (Training Instructions)
-- ═══════════════════════════════════════════════════════════════
-- Training instructions that get injected into AI system prompts.
-- Higher priority entries appear first in the prompt context.

create table public.ai_memories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references public.user_profiles(id) on delete set null,

  title text not null,
  category text not null check (category in (
    'tone_and_style', 'product_knowledge', 'objection_handling',
    'pricing_rules', 'compliance_rules', 'general'
  )),
  content text not null,
  is_enabled boolean default true,
  priority integer default 0,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_ai_memories_org on ai_memories(organization_id);
create index idx_ai_memories_active on ai_memories(organization_id, is_enabled, priority desc);

alter table ai_memories enable row level security;
create policy "ai_memories_org_access" on ai_memories
  for all using (organization_id = public.get_user_org_id());

-- ═══════════════════════════════════════════════════════════════
-- 2. AI KNOWLEDGE ARTICLES
-- ═══════════════════════════════════════════════════════════════
-- Knowledge base documents the AI retrieves contextually.
-- Supports full-text search and tag-based filtering.

create table public.ai_knowledge_articles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references public.user_profiles(id) on delete set null,

  title text not null,
  category text not null check (category in (
    'procedures', 'pricing', 'faqs', 'aftercare', 'financing', 'general'
  )),
  content text not null,
  tags text[] default '{}',
  is_enabled boolean default true,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_ai_knowledge_org on ai_knowledge_articles(organization_id);
create index idx_ai_knowledge_search on ai_knowledge_articles
  using gin (to_tsvector('english', title || ' ' || content));
create index idx_ai_knowledge_tags on ai_knowledge_articles using gin(tags);

alter table ai_knowledge_articles enable row level security;
create policy "ai_knowledge_org_access" on ai_knowledge_articles
  for all using (organization_id = public.get_user_org_id());

-- ═══════════════════════════════════════════════════════════════
-- 3. AI TEST CONVERSATIONS (Playground History)
-- ═══════════════════════════════════════════════════════════════
-- Saved playground conversations for review and iteration.
-- Messages stored as JSONB array for simplicity.

create table public.ai_test_conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references public.user_profiles(id) on delete set null,

  title text not null default 'Untitled Conversation',
  mode text not null default 'general',
  messages jsonb not null default '[]'::jsonb,
  system_prompt_snapshot text,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_ai_test_convos_org on ai_test_conversations(organization_id, created_at desc);

alter table ai_test_conversations enable row level security;
create policy "ai_test_convos_org_access" on ai_test_conversations
  for all using (organization_id = public.get_user_org_id());

-- ═══════════════════════════════════════════════════════════════
-- 4. UPDATED_AT TRIGGERS
-- ═══════════════════════════════════════════════════════════════

create or replace function update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger ai_memories_updated_at
  before update on ai_memories
  for each row execute function update_updated_at_column();

create trigger ai_knowledge_articles_updated_at
  before update on ai_knowledge_articles
  for each row execute function update_updated_at_column();

create trigger ai_test_conversations_updated_at
  before update on ai_test_conversations
  for each row execute function update_updated_at_column();
