-- Migration 002: Leads and Pipeline
-- Core lead management with dental-specific fields

-- ============================================
-- PIPELINE STAGES
-- ============================================
create table public.pipeline_stages (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  slug text not null,
  description text,
  color text default '#6B7280',
  position integer not null default 0,
  is_default boolean default false,
  is_won boolean default false,
  is_lost boolean default false,
  auto_actions jsonb default '[]', -- triggers when lead enters stage
  created_at timestamptz default now()
);

create unique index idx_pipeline_stages_org_slug on public.pipeline_stages(organization_id, slug);
create index idx_pipeline_stages_org_pos on public.pipeline_stages(organization_id, position);

-- ============================================
-- LEAD SOURCES
-- ============================================
create table public.lead_sources (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null, -- "Google Ads - All on 4", "Meta - Implant Campaign"
  type text not null check (type in ('google_ads', 'meta_ads', 'website_form', 'landing_page', 'referral', 'walk_in', 'phone', 'email_campaign', 'sms_campaign', 'other')),
  utm_source text,
  utm_medium text,
  utm_campaign text,
  cost_per_lead numeric(10,2),
  is_active boolean default true,
  metadata jsonb default '{}',
  created_at timestamptz default now()
);

create index idx_lead_sources_org on public.lead_sources(organization_id);

-- ============================================
-- LEADS
-- ============================================
create table public.leads (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- Basic info
  first_name text not null,
  last_name text,
  email text,
  phone text,
  phone_formatted text, -- E.164 format for Twilio
  avatar_url text,

  -- Demographics
  date_of_birth date,
  age integer,
  gender text,
  city text,
  state text,
  zip_code text,
  timezone text default 'America/New_York',
  preferred_language text default 'en',

  -- Dental-specific fields
  dental_condition text check (dental_condition in ('missing_all_upper', 'missing_all_lower', 'missing_all_both', 'missing_multiple', 'failing_teeth', 'denture_problems', 'other')),
  dental_condition_details text,
  current_dental_situation text, -- free-form description
  has_dentures boolean,
  has_dental_insurance boolean,
  insurance_provider text,
  insurance_details jsonb,
  medical_conditions text[], -- array of conditions
  medications text[],
  smoker boolean,

  -- Financial qualification
  financing_interest text check (financing_interest in ('cash_pay', 'financing_needed', 'insurance_only', 'undecided')),
  budget_range text check (budget_range in ('under_10k', '10k_15k', '15k_20k', '20k_25k', '25k_30k', 'over_30k', 'unknown')),
  financing_approved boolean,
  financing_amount numeric(10,2),

  -- Pipeline tracking
  stage_id uuid references public.pipeline_stages(id),
  status text not null default 'new' check (status in ('new', 'contacted', 'qualified', 'consultation_scheduled', 'consultation_completed', 'treatment_presented', 'financing', 'contract_sent', 'contract_signed', 'scheduled', 'in_treatment', 'completed', 'lost', 'disqualified', 'no_show', 'unresponsive')),

  -- Source tracking
  source_id uuid references public.lead_sources(id),
  source_type text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  landing_page_url text,
  referrer_url text,
  gclid text, -- Google Click ID
  fbclid text, -- Facebook Click ID

  -- AI scoring
  ai_score integer default 0 check (ai_score >= 0 and ai_score <= 100),
  ai_qualification text default 'unscored' check (ai_qualification in ('hot', 'warm', 'cold', 'unqualified', 'unscored')),
  ai_score_breakdown jsonb default '{}', -- detailed scoring per dimension
  ai_score_updated_at timestamptz,
  ai_summary text, -- AI-generated lead summary

  -- Engagement metrics
  total_messages_sent integer default 0,
  total_messages_received integer default 0,
  total_emails_sent integer default 0,
  total_emails_opened integer default 0,
  total_sms_sent integer default 0,
  total_sms_received integer default 0,
  last_contacted_at timestamptz,
  last_responded_at timestamptz,
  response_time_avg_minutes integer,
  engagement_score integer default 0,

  -- Assignment
  assigned_to uuid references public.user_profiles(id),

  -- Scheduling
  consultation_date timestamptz,
  consultation_type text check (consultation_type in ('in_person', 'virtual', 'phone')),
  treatment_date timestamptz,

  -- Financial
  treatment_value numeric(10,2),
  actual_revenue numeric(10,2),

  -- Metadata
  tags text[] default '{}',
  custom_fields jsonb default '{}',
  notes text,

  -- Disqualification
  disqualified_reason text,
  lost_reason text,
  no_show_count integer default 0,

  -- Timestamps
  first_contact_at timestamptz,
  qualified_at timestamptz,
  converted_at timestamptz,
  lost_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Indexes for common queries
create index idx_leads_org on public.leads(organization_id);
create index idx_leads_org_status on public.leads(organization_id, status);
create index idx_leads_org_stage on public.leads(organization_id, stage_id);
create index idx_leads_org_score on public.leads(organization_id, ai_score desc);
create index idx_leads_org_qualification on public.leads(organization_id, ai_qualification);
create index idx_leads_org_assigned on public.leads(organization_id, assigned_to);
create index idx_leads_email on public.leads(organization_id, email);
create index idx_leads_phone on public.leads(organization_id, phone);
create index idx_leads_created on public.leads(organization_id, created_at desc);
create index idx_leads_source on public.leads(organization_id, source_id);

-- ============================================
-- LEAD ACTIVITIES (audit trail)
-- ============================================
create table public.lead_activities (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  user_id uuid references public.user_profiles(id),

  activity_type text not null check (activity_type in (
    'created', 'updated', 'stage_changed', 'status_changed', 'score_updated',
    'note_added', 'email_sent', 'email_opened', 'email_clicked',
    'sms_sent', 'sms_received', 'call_made', 'call_received',
    'appointment_scheduled', 'appointment_completed', 'appointment_no_show',
    'treatment_presented', 'contract_sent', 'contract_signed',
    'financing_applied', 'financing_approved', 'financing_denied',
    'assigned', 'unassigned', 'tagged', 'disqualified', 'requalified',
    'ai_interaction', 'campaign_enrolled', 'campaign_completed'
  )),

  title text not null,
  description text,
  metadata jsonb default '{}', -- flexible data per activity type

  created_at timestamptz default now()
);

create index idx_lead_activities_lead on public.lead_activities(lead_id, created_at desc);
create index idx_lead_activities_org on public.lead_activities(organization_id, created_at desc);

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================
alter table public.pipeline_stages enable row level security;
alter table public.lead_sources enable row level security;
alter table public.leads enable row level security;
alter table public.lead_activities enable row level security;

-- Pipeline stages policies
create policy "Users can view pipeline stages in their org"
  on public.pipeline_stages for select
  using (organization_id = public.get_user_org_id());

create policy "Admins can manage pipeline stages"
  on public.pipeline_stages for all
  using (organization_id = public.get_user_org_id());

-- Lead sources policies
create policy "Users can view lead sources in their org"
  on public.lead_sources for select
  using (organization_id = public.get_user_org_id());

create policy "Admins can manage lead sources"
  on public.lead_sources for all
  using (organization_id = public.get_user_org_id());

-- Leads policies
create policy "Users can view leads in their org"
  on public.leads for select
  using (organization_id = public.get_user_org_id());

create policy "Users can create leads in their org"
  on public.leads for insert
  with check (organization_id = public.get_user_org_id());

create policy "Users can update leads in their org"
  on public.leads for update
  using (organization_id = public.get_user_org_id());

create policy "Admins can delete leads"
  on public.leads for delete
  using (organization_id = public.get_user_org_id());

-- Lead activities policies
create policy "Users can view activities in their org"
  on public.lead_activities for select
  using (organization_id = public.get_user_org_id());

create policy "Users can create activities in their org"
  on public.lead_activities for insert
  with check (organization_id = public.get_user_org_id());

-- ============================================
-- TRIGGERS
-- ============================================
create trigger set_leads_updated_at
  before update on public.leads
  for each row execute function public.handle_updated_at();

-- ============================================
-- SEED DEFAULT PIPELINE STAGES
-- ============================================
create or replace function public.seed_default_pipeline_stages()
returns trigger as $$
begin
  insert into public.pipeline_stages (organization_id, name, slug, color, position, is_default) values
    (new.id, 'New Lead', 'new', '#3B82F6', 0, true),
    (new.id, 'Contacted', 'contacted', '#8B5CF6', 1, false),
    (new.id, 'Qualified', 'qualified', '#F59E0B', 2, false),
    (new.id, 'Consultation Scheduled', 'consultation-scheduled', '#10B981', 3, false),
    (new.id, 'Consultation Completed', 'consultation-completed', '#06B6D4', 4, false),
    (new.id, 'Treatment Presented', 'treatment-presented', '#EC4899', 5, false),
    (new.id, 'Financing', 'financing', '#F97316', 6, false),
    (new.id, 'Contract Signed', 'contract-signed', '#14B8A6', 7, false),
    (new.id, 'Scheduled for Treatment', 'scheduled', '#6366F1', 8, false);

  insert into public.pipeline_stages (organization_id, name, slug, color, position, is_won) values
    (new.id, 'Completed', 'completed', '#22C55E', 9, true);

  insert into public.pipeline_stages (organization_id, name, slug, color, position, is_lost) values
    (new.id, 'Lost', 'lost', '#EF4444', 10, true);

  return new;
end;
$$ language plpgsql;

create trigger seed_pipeline_stages_on_org_create
  after insert on public.organizations
  for each row execute function public.seed_default_pipeline_stages();
