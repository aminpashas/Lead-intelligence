-- Workstream C2: persisted pipeline recommendations + feedback loop.
--
-- WHAT: the Pipeline recommendation band was computed live on every page load
-- and forgotten. This table makes each recommendation a first-class row so:
--   1. The hourly pipeline-recommendations cron persists the rules engine's
--      output (origin 'rules') and an LLM analyst's reranks/insights
--      (origin 'llm_analyst') — the page then READS instead of recomputing.
--   2. Apply/dismiss stamp status + acted_by, closing the feedback loop
--      (who acted, human or AI, and when).
--   3. The daily recommendation-outcomes cron measures 30-day conversions and
--      revenue for acted-on rows into `outcome`, so recommendation quality is
--      eventually rateable.
--
-- Dedupe: `dedupe_key` matches the live engine's stable rec ids
-- ('<kind>:<stageId>') or 'analyst:<slug>' for LLM insights. One OPEN row per
-- key per org (partial unique index); re-syncs refresh the open row in place,
-- while acted-on/expired rows keep their history.
--
-- NOTE ON FILENAME: the C2 spec named this 20260711200000_… but that version
-- was already taken by 20260711200000_voice_channel_check.sql (concurrent
-- workstream), so this file uses 20260711202000 to keep versions unique.

create table public.pipeline_recommendations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- 'kind:stageId' (rules engine rec ids) or 'analyst:<slug>' (LLM insights).
  dedupe_key text not null,
  kind text not null,
  origin text not null default 'rules' check (origin in ('rules', 'llm_analyst')),
  title text not null,
  detail text not null,
  -- SmartListCriteria — the exact segment Apply materializes.
  segment_criteria jsonb not null,
  lead_count int not null,
  expected_value_usd numeric,
  avg_close_probability numeric(4,3),
  -- RecommendationEvidence[] — explainability facts ({metric, value, source}).
  evidence jsonb not null default '[]'::jsonb,
  -- C3 execution descriptor ({version, executor, action, segment, guardrails},
  -- plus a `presentation` key carrying the UI action/cta for round-tripping).
  execution jsonb not null default '{}'::jsonb,
  priority int not null,
  status text not null default 'open' check (status in (
    'open', 'applied', 'dismissed', 'expired', 'superseded')),
  -- Who acted on it: 'ai' for auto/bulk paths, 'human' when it was routed to a
  -- person (dismiss, or apply that created a human task).
  acted_by text check (acted_by in ('human', 'ai')),
  acted_by_user uuid references public.user_profiles(id),
  acted_at timestamptz,
  -- Measured by the recommendation-outcomes cron ~30d after acted_at:
  -- {conversions_30d, revenue_30d, ...method notes}.
  outcome jsonb,
  outcome_measured_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Freshness horizon: an open row the sync stops refreshing goes stale after
  -- this and drops out of the page read even before it's marked 'expired'.
  expires_at timestamptz
);

-- One LIVE recommendation per (org, key); history rows fall out of the index.
create unique index pipeline_recommendations_open_dedupe_uniq
  on public.pipeline_recommendations (organization_id, dedupe_key)
  where status = 'open';

-- Page read: open recs by priority.
create index pipeline_recommendations_org_status_priority_idx
  on public.pipeline_recommendations (organization_id, status, priority desc);

-- Outcome cron scan: acted-on rows not yet measured.
create index pipeline_recommendations_outcome_due_idx
  on public.pipeline_recommendations (acted_at)
  where outcome is null and status in ('applied', 'dismissed');

create trigger set_pipeline_recommendations_updated_at
  before update on public.pipeline_recommendations
  for each row execute function public.handle_updated_at();

alter table public.pipeline_recommendations enable row level security;

-- Org members read the band and perform status transitions (apply/dismiss).
-- Writes of NEW rows are cron-only (service role bypasses RLS) — users never
-- insert or delete recommendations, so no insert/delete policies.
create policy "Users can view pipeline_recommendations in their org"
  on public.pipeline_recommendations for select
  using (organization_id = get_user_org_id());
create policy "Users can update pipeline_recommendations in their org"
  on public.pipeline_recommendations for update
  using (organization_id = get_user_org_id());

-- human_tasks.recommendation_id was created as a plain uuid in
-- 20260711160000_human_tasks.sql with the FK deferred to this migration.
alter table public.human_tasks
  add constraint human_tasks_recommendation_fk
  foreign key (recommendation_id) references public.pipeline_recommendations(id)
  on delete set null;
