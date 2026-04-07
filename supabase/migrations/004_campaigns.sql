-- Migration 004: Campaigns and Sequences
-- Drip campaigns for SMS + Email nurturing

-- ============================================
-- CAMPAIGNS
-- ============================================
create table public.campaigns (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references public.user_profiles(id),

  name text not null,
  description text,
  type text not null check (type in ('drip', 'broadcast', 'trigger')),
  channel text not null check (channel in ('sms', 'email', 'multi')),

  status text default 'draft' check (status in ('draft', 'active', 'paused', 'completed', 'archived')),

  -- Targeting
  target_criteria jsonb default '{}', -- filter rules for auto-enrollment
  -- e.g., {"status": ["new", "contacted"], "ai_qualification": ["warm", "hot"], "source_type": ["google_ads"]}

  -- Schedule
  start_at timestamptz,
  end_at timestamptz,
  send_window jsonb, -- {"start_hour": 9, "end_hour": 20, "timezone": "America/New_York", "days": [1,2,3,4,5]}

  -- Stats
  total_enrolled integer default 0,
  total_completed integer default 0,
  total_converted integer default 0,
  total_unsubscribed integer default 0,

  metadata jsonb default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_campaigns_org on public.campaigns(organization_id, status);

-- ============================================
-- CAMPAIGN STEPS
-- ============================================
create table public.campaign_steps (
  id uuid primary key default uuid_generate_v4(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,

  step_number integer not null,
  name text,
  channel text not null check (channel in ('sms', 'email')),

  -- Timing
  delay_minutes integer not null default 0, -- delay from previous step (or enrollment)
  delay_type text default 'after_previous' check (delay_type in ('after_previous', 'after_enrollment', 'specific_time')),

  -- Content
  subject text, -- email subject
  body_template text not null, -- supports {{first_name}}, {{practice_name}} etc.
  ai_personalize boolean default false, -- AI personalizes per lead

  -- Conditions
  send_condition jsonb, -- e.g., {"if_no_reply_within": 24, "if_score_above": 50}
  exit_condition jsonb, -- e.g., {"if_replied": true, "if_status_in": ["qualified"]}

  -- Stats
  total_sent integer default 0,
  total_delivered integer default 0,
  total_opened integer default 0,
  total_replied integer default 0,

  created_at timestamptz default now()
);

create index idx_campaign_steps_campaign on public.campaign_steps(campaign_id, step_number);

-- ============================================
-- CAMPAIGN ENROLLMENTS
-- ============================================
create table public.campaign_enrollments (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,

  status text default 'active' check (status in ('active', 'paused', 'completed', 'exited', 'unsubscribed')),

  current_step integer default 0,
  next_step_at timestamptz,
  completed_at timestamptz,
  exited_at timestamptz,
  exit_reason text,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index idx_campaign_enrollments_unique on public.campaign_enrollments(campaign_id, lead_id);
create index idx_campaign_enrollments_next on public.campaign_enrollments(next_step_at) where status = 'active';
create index idx_campaign_enrollments_lead on public.campaign_enrollments(lead_id);

-- ============================================
-- APPOINTMENTS
-- ============================================
create table public.appointments (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  assigned_to uuid references public.user_profiles(id),

  type text not null check (type in ('consultation', 'follow_up', 'treatment', 'scan', 'other')),
  status text default 'scheduled' check (status in ('scheduled', 'confirmed', 'completed', 'no_show', 'canceled', 'rescheduled')),

  scheduled_at timestamptz not null,
  duration_minutes integer default 60,
  location text,
  notes text,

  -- Reminders
  reminder_sent_24h boolean default false,
  reminder_sent_1h boolean default false,
  confirmation_received boolean default false,

  completed_at timestamptz,
  no_show_at timestamptz,
  canceled_at timestamptz,

  metadata jsonb default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_appointments_org on public.appointments(organization_id, scheduled_at);
create index idx_appointments_lead on public.appointments(lead_id);

-- ============================================
-- DAILY ANALYTICS (pre-aggregated)
-- ============================================
create table public.daily_analytics (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  date date not null,

  -- Lead metrics
  new_leads integer default 0,
  qualified_leads integer default 0,
  disqualified_leads integer default 0,
  consultations_scheduled integer default 0,
  consultations_completed integer default 0,
  no_shows integer default 0,
  contracts_signed integer default 0,

  -- Revenue
  treatment_value_presented numeric(12,2) default 0,
  treatment_value_accepted numeric(12,2) default 0,
  revenue_closed numeric(12,2) default 0,

  -- Engagement
  sms_sent integer default 0,
  sms_received integer default 0,
  emails_sent integer default 0,
  emails_opened integer default 0,
  ai_interactions integer default 0,
  ai_cost_usd numeric(10,4) default 0,

  -- Source breakdown (stored as JSONB for flexibility)
  leads_by_source jsonb default '{}',
  conversions_by_source jsonb default '{}',

  created_at timestamptz default now()
);

create unique index idx_daily_analytics_org_date on public.daily_analytics(organization_id, date);

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================
alter table public.campaigns enable row level security;
alter table public.campaign_steps enable row level security;
alter table public.campaign_enrollments enable row level security;
alter table public.appointments enable row level security;
alter table public.daily_analytics enable row level security;

create policy "Users can view campaigns in their org"
  on public.campaigns for select using (organization_id = public.get_user_org_id());
create policy "Users can manage campaigns in their org"
  on public.campaigns for all using (organization_id = public.get_user_org_id());

create policy "Users can view campaign steps in their org"
  on public.campaign_steps for select using (organization_id = public.get_user_org_id());
create policy "Users can manage campaign steps in their org"
  on public.campaign_steps for all using (organization_id = public.get_user_org_id());

create policy "Users can view enrollments in their org"
  on public.campaign_enrollments for select using (organization_id = public.get_user_org_id());
create policy "Users can manage enrollments in their org"
  on public.campaign_enrollments for all using (organization_id = public.get_user_org_id());

create policy "Users can view appointments in their org"
  on public.appointments for select using (organization_id = public.get_user_org_id());
create policy "Users can manage appointments in their org"
  on public.appointments for all using (organization_id = public.get_user_org_id());

create policy "Users can view analytics in their org"
  on public.daily_analytics for select using (organization_id = public.get_user_org_id());

-- ============================================
-- TRIGGERS
-- ============================================
create trigger set_campaigns_updated_at
  before update on public.campaigns
  for each row execute function public.handle_updated_at();

create trigger set_campaign_enrollments_updated_at
  before update on public.campaign_enrollments
  for each row execute function public.handle_updated_at();

create trigger set_appointments_updated_at
  before update on public.appointments
  for each row execute function public.handle_updated_at();
