-- Migration 025: Phase 2 Intelligence Layer
--
-- Adds:
--   1. conversations.summary       — AI-generated rolling summary (Claude haiku)
--   2. conversations.summary_*     — bookkeeping (last update, tokens spent)
--   3. reviews                     — pulled from Google Business Profile API
--   4. leads.fbc / leads.fbp       — Meta cookies captured at form submit for CAPI match quality
--   5. ai_usage                    — per-call token + cost log (caps + observability)
--
-- Brief reference: Sections 3.1, 3.2, 3.3, 3.5 (Phase 2)
-- Plan: ~/.claude/plans/woolly-tumbling-kite.md

-- ============================================
-- 1. CONVERSATION SUMMARY
-- ============================================
alter table public.conversations add column if not exists summary text;
alter table public.conversations add column if not exists summary_updated_at timestamptz;
alter table public.conversations add column if not exists summary_message_count integer default 0;

comment on column public.conversations.summary is 'Rolling Claude-generated summary so staff and downstream agents do not re-read full transcripts.';
comment on column public.conversations.summary_message_count is 'Message count at the time of the last summary; lets us debounce re-summarization.';

-- ============================================
-- 2. REVIEWS (Google Business Profile pull)
-- ============================================
create table public.reviews (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  source text not null default 'gbp' check (source in ('gbp', 'yelp', 'healthgrades', 'manual')),
  external_id text not null,                -- e.g. GBP review name path
  external_url text,
  reviewer_name text,
  reviewer_avatar_url text,
  star_rating integer check (star_rating between 1 and 5),
  review_text text,
  reviewed_at timestamptz,                  -- when the customer left it (per GBP)

  -- Claude sentiment scoring
  sentiment text check (sentiment in ('positive', 'neutral', 'negative')),
  sentiment_score numeric(4,2),             -- -1.00 to 1.00
  topics text[],                            -- e.g. ['wait_time', 'staff_friendliness']
  sentiment_analyzed_at timestamptz,

  -- Auto-drafted response (NEVER auto-published — staff approves)
  draft_response text,
  draft_response_at timestamptz,
  draft_model text,

  response_status text not null default 'unresponded'
    check (response_status in ('unresponded', 'drafted', 'approved', 'published', 'declined')),
  response_text text,                       -- final published response (if any)
  responded_at timestamptz,
  responded_by uuid references public.user_profiles(id),

  metadata jsonb default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index idx_reviews_external on public.reviews(organization_id, source, external_id);
create index idx_reviews_org_status on public.reviews(organization_id, response_status, reviewed_at desc);
create index idx_reviews_org_sentiment on public.reviews(organization_id, sentiment) where sentiment is not null;

comment on table public.reviews is 'Reviews pulled from Google Business Profile (and other sources later). Sentiment-scored by Claude; responses are drafted automatically but require staff approval before publish.';

-- ============================================
-- 3. META COOKIES ON LEADS (for CAPI match quality)
-- ============================================
-- fbc and fbp are Meta's first-party cookies. Capturing them at form submit and forwarding via
-- the Conversions API is required to hit match quality score >= 7.0 (brief Phase 2 acceptance).
alter table public.leads add column if not exists fbc text;
alter table public.leads add column if not exists fbp text;

comment on column public.leads.fbc is 'Meta _fbc cookie value captured at form submit. Forwarded to Conversions API for browser↔server event dedupe + match quality.';
comment on column public.leads.fbp is 'Meta _fbp cookie value captured at form submit. Required for >7.0 match quality on CAPI.';

-- ============================================
-- 4. AI USAGE LOG (per-lead per-day token cap + cost observability)
-- ============================================
create table if not exists public.ai_usage (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete set null,

  feature text not null,                    -- 'summarize', 'personalize', 'score', 'sentiment_review', 'compliance_filter'
  model text not null,                      -- 'claude-haiku-4-5', 'claude-sonnet-4-20250514', etc.
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  cost_cents numeric(10,4) default 0,       -- estimated cost in cents
  duration_ms integer,
  succeeded boolean not null default true,
  error_message text,

  metadata jsonb default '{}',
  occurred_at timestamptz not null default now()
);

create index idx_ai_usage_org_occurred on public.ai_usage(organization_id, occurred_at desc);
create index idx_ai_usage_lead_day on public.ai_usage(lead_id, occurred_at desc) where lead_id is not null;
create index idx_ai_usage_feature on public.ai_usage(organization_id, feature, occurred_at desc);

comment on table public.ai_usage is 'Per-call AI cost + token observability. Used to enforce per-lead per-day budget caps (brief §3.2) and to roll up daily AI spend for the analytics dashboard.';

-- ============================================
-- 5. EXTEND campaigns + campaign_steps channels to include 'voice'
--    Lets the Reactivation campaign Day 10 step place a Retell outbound call
--    instead of an SMS placeholder. The campaign executor switches on channel.
-- ============================================
alter table public.campaigns drop constraint if exists campaigns_channel_check;
alter table public.campaigns add constraint campaigns_channel_check
  check (channel in ('sms', 'email', 'multi', 'voice'));

alter table public.campaign_steps drop constraint if exists campaign_steps_channel_check;
alter table public.campaign_steps add constraint campaign_steps_channel_check
  check (channel in ('sms', 'email', 'voice'));

-- ============================================
-- 6. updated_at TRIGGERS for new tables
-- ============================================
create trigger set_reviews_updated_at
  before update on public.reviews
  for each row execute function public.handle_updated_at();

-- ============================================
-- 7. UPGRADE Reactivation Day-10 step from SMS placeholder → voice
--    Migration 024 seeded Day 10 as an SMS placeholder because Retell outbound
--    wasn't wired yet. Phase 2 wires it; flip the seeded steps to voice and update
--    the body to a short transcript hint (placeOutboundCallToLead uses it as a fallback).
--    Per-org tweaks staff have made are preserved (we only update rows still matching
--    the original placeholder body).
-- ============================================
update public.campaign_steps
set
  channel = 'voice',
  name = 'Day 10 — Reactivation voice check-in (Retell)',
  body_template = 'Hi {{first_name}}, this is the team at {{practice_name}}. We noticed it''s been a while — calling to see if you''re still interested. No pressure, just wanted to check in.'
where step_number = 4
  and name like 'Day 10%'
  and channel = 'sms';

-- Recreate the seed function so future organizations get the voice step directly.
create or replace function public.seed_reactivation_campaign(p_org_id uuid)
returns uuid as $$
declare
  v_campaign_id uuid;
begin
  select id into v_campaign_id
  from public.campaigns
  where organization_id = p_org_id and name = 'Reactivation'
  limit 1;
  if v_campaign_id is not null then
    return v_campaign_id;
  end if;

  insert into public.campaigns (organization_id, name, description, type, channel, status, target_criteria, metadata)
  values (
    p_org_id, 'Reactivation',
    'Default 14-day reactivation sequence for dormant leads (no activity > 60 days).',
    'trigger', 'multi', 'active',
    '{"status": ["dormant"]}'::jsonb,
    '{"seeded_by": "migration_024", "auto_managed": true}'::jsonb
  )
  returning id into v_campaign_id;

  insert into public.campaign_steps (campaign_id, organization_id, step_number, name, channel, delay_minutes, body_template, ai_personalize)
  values (
    v_campaign_id, p_org_id, 1, 'Day 0 — SMS check-in', 'sms', 0,
    'Hi {{first_name}}, it''s {{practice_name}}. We noticed it''s been a while since we last connected. Still interested in exploring your options? Reply YES and we''ll find a time that works.',
    false
  );

  insert into public.campaign_steps (campaign_id, organization_id, step_number, name, channel, delay_minutes, subject, body_template, ai_personalize, exit_condition)
  values (
    v_campaign_id, p_org_id, 2, 'Day 2 — Email follow-up', 'email', 2 * 24 * 60,
    'Still thinking it over, {{first_name}}?',
    'Hi {{first_name}},' || E'\n\n' ||
    'No pressure at all — just wanted to follow up on the inquiry you sent us at {{practice_name}}.' || E'\n\n' ||
    'A lot of patients in your situation worry about cost or recovery time. Both are easier to plan around than you''d think — financing is straightforward and the consult itself is free.' || E'\n\n' ||
    'If now isn''t the right time, just reply and let me know. Otherwise, here''s a link to grab a slot whenever works for you.' || E'\n\n' ||
    '— The team at {{practice_name}}',
    false,
    '{"if_replied": true}'::jsonb
  );

  insert into public.campaign_steps (campaign_id, organization_id, step_number, name, channel, delay_minutes, body_template, ai_personalize, exit_condition)
  values (
    v_campaign_id, p_org_id, 3, 'Day 5 — SMS soft offer', 'sms', 3 * 24 * 60,
    'Hey {{first_name}} — totally understand if now isn''t the right time. Want me to send you some info to look at when you''re ready instead? No commitment.',
    false,
    '{"if_replied": true}'::jsonb
  );

  insert into public.campaign_steps (campaign_id, organization_id, step_number, name, channel, delay_minutes, body_template, ai_personalize, exit_condition)
  values (
    v_campaign_id, p_org_id, 4, 'Day 10 — Reactivation voice check-in (Retell)', 'voice', 5 * 24 * 60,
    'Hi {{first_name}}, this is the team at {{practice_name}}. We noticed it''s been a while — calling to see if you''re still interested. No pressure, just wanted to check in.',
    false,
    '{"if_replied": true}'::jsonb
  );

  return v_campaign_id;
end;
$$ language plpgsql;

-- ============================================
-- 8. RLS
-- ============================================
alter table public.reviews enable row level security;
alter table public.ai_usage enable row level security;

create policy "Users can view reviews in their org"
  on public.reviews for select using (organization_id = public.get_user_org_id());
create policy "Users can manage reviews in their org"
  on public.reviews for all using (organization_id = public.get_user_org_id());

create policy "Users can view ai_usage in their org"
  on public.ai_usage for select using (organization_id = public.get_user_org_id());
-- INSERTs to ai_usage happen via service role (no user policy = denied for authenticated users).
