-- Migration 005: Patient Intelligence — AI Agent Memory & Analysis
-- Adds tables for patient psychology profiles, conversation analysis,
-- and HIPAA compliance audit logging.

-- ═══════════════════════════════════════════════════════════════
-- 1. PATIENT PSYCHOLOGY PROFILES (Sales Agent Memory)
-- ═══════════════════════════════════════════════════════════════
-- Stores AI-analyzed psychological profile for each lead.
-- Updated after every conversation. This IS the agent's "memory."

create table public.patient_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,

  -- Personality & Psychology
  personality_type text, -- e.g., 'analytical', 'driver', 'expressive', 'amiable'
  communication_style text, -- e.g., 'direct', 'detailed', 'emotional', 'reserved'
  decision_making_style text, -- e.g., 'impulsive', 'methodical', 'consensus-seeking', 'risk-averse'
  trust_level text default 'unknown', -- 'very_low', 'low', 'neutral', 'high', 'very_high'

  -- Emotional State
  emotional_state text default 'unknown', -- current dominant emotion
  anxiety_level integer default 0 check (anxiety_level between 0 and 10),
  confidence_level integer default 5 check (confidence_level between 0 and 10),
  motivation_level integer default 5 check (motivation_level between 0 and 10),

  -- Pain Points (JSONB array of identified pain points with severity)
  pain_points jsonb default '[]'::jsonb,
  -- e.g. [{"point": "can't eat solid food", "severity": 9, "mentioned_count": 3, "first_mentioned": "2024-01-15"}]

  -- Desires & Goals
  desires jsonb default '[]'::jsonb,
  -- e.g. [{"desire": "eat steak again", "importance": 10, "mentioned_count": 2}]

  -- Objections & Concerns (tracked over time)
  objections jsonb default '[]'::jsonb,
  -- e.g. [{"objection": "cost", "severity": 8, "addressed": false, "approach_used": null}]

  -- Negotiation Intelligence
  price_sensitivity integer default 5 check (price_sensitivity between 0 and 10),
  urgency_perception integer default 5 check (urgency_perception between 0 and 10),
  negotiation_style text, -- 'collaborative', 'competitive', 'avoidant', 'accommodating'
  influence_factors jsonb default '[]'::jsonb, -- what motivates them: 'family', 'self-image', 'health', 'social', 'practical'

  -- Relationship & Rapport
  rapport_score integer default 0 check (rapport_score between 0 and 10),
  personal_details jsonb default '{}', -- remembered non-medical details (hobbies, family, job)
  preferred_contact_time text, -- when they tend to respond
  preferred_channel text, -- which channel gets best engagement
  humor_receptivity text default 'unknown', -- 'high', 'moderate', 'low', 'avoid'

  -- Engagement History Summary
  total_conversations_analyzed integer default 0,
  key_moments jsonb default '[]'::jsonb, -- breakthrough moments, setbacks, important exchanges
  -- e.g. [{"date": "2024-01-15", "type": "breakthrough", "description": "opened up about embarrassment"}]

  -- AI-Generated Insights
  ai_summary text, -- current overall summary of patient psychology
  next_best_action text, -- AI recommendation for next engagement
  recommended_tone text, -- how to approach next conversation
  topics_to_avoid jsonb default '[]'::jsonb, -- sensitive subjects
  topics_to_emphasize jsonb default '[]'::jsonb, -- what resonates

  -- Metadata
  last_analyzed_at timestamptz,
  analysis_version integer default 1,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),

  constraint unique_lead_profile unique (lead_id)
);

create index idx_patient_profiles_org on patient_profiles(organization_id);
create index idx_patient_profiles_lead on patient_profiles(lead_id);

alter table patient_profiles enable row level security;
create policy "patient_profiles_org_access" on patient_profiles
  for all using (organization_id = public.get_user_org_id());

-- ═══════════════════════════════════════════════════════════════
-- 2. CONVERSATION ANALYSIS (Conversation Analyst Agent)
-- ═══════════════════════════════════════════════════════════════
-- Per-conversation analysis storing tone, sentiment, engagement metrics

create table public.conversation_analyses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,

  -- Overall Scores (0-10 scale)
  emotional_score integer check (emotional_score between 0 and 10),
  engagement_score integer check (engagement_score between 0 and 10),
  trust_score integer check (trust_score between 0 and 10),
  urgency_score integer check (urgency_score between 0 and 10),

  -- Tone Analysis
  patient_tone text, -- 'warm', 'neutral', 'cold', 'anxious', 'excited', 'frustrated', 'defensive'
  staff_tone text, -- 'professional', 'empathetic', 'pushy', 'cold', 'warm', 'aggressive'
  tone_alignment text, -- 'matched', 'mismatched', 'improving', 'deteriorating'

  -- Sales Quality Metrics (0-10 scale)
  sales_pressure_level integer check (sales_pressure_level between 0 and 10), -- 0=no pressure, 10=very pushy
  empathy_level integer check (empathy_level between 0 and 10),
  active_listening_score integer check (active_listening_score between 0 and 10),
  objection_handling_quality integer check (objection_handling_quality between 0 and 10),
  rapport_building_score integer check (rapport_building_score between 0 and 10),

  -- Patient Engagement Signals
  patient_openness integer check (patient_openness between 0 and 10), -- how open/sharing they are
  patient_buying_signals integer check (patient_buying_signals between 0 and 10), -- purchase intent
  patient_resistance integer check (patient_resistance between 0 and 10), -- resistance level
  response_enthusiasm text, -- 'very_positive', 'positive', 'neutral', 'declining', 'negative'

  -- Conversation Dynamics
  message_count integer,
  avg_response_time_seconds integer,
  longest_message_by text, -- 'patient' or 'staff' — who writes longer messages
  conversation_flow text, -- 'natural', 'scripted', 'disjointed', 'flowing'
  turning_points jsonb default '[]'::jsonb, -- moments where tone/engagement shifted

  -- Red Flags & Opportunities
  red_flags jsonb default '[]'::jsonb,
  -- e.g. [{"flag": "patient mentioned competitor", "severity": "high", "message_index": 5}]
  opportunities jsonb default '[]'::jsonb,
  -- e.g. [{"opportunity": "patient asked about financing", "type": "buying_signal", "message_index": 8}]

  -- AI Coaching (for staff improvement)
  coaching_notes text, -- specific feedback for the staff member
  improvement_areas jsonb default '[]'::jsonb,
  things_done_well jsonb default '[]'::jsonb,

  -- HIPAA Compliance Flags
  phi_detected boolean default false,
  phi_details jsonb default '[]'::jsonb, -- what PHI was found and where
  compliance_score integer check (compliance_score between 0 and 100),
  compliance_issues jsonb default '[]'::jsonb,

  -- Metadata
  analyzed_at timestamptz default now(),
  model_used text,
  analysis_version integer default 1,
  created_at timestamptz default now()
);

create index idx_conv_analyses_org on conversation_analyses(organization_id, analyzed_at desc);
create index idx_conv_analyses_conv on conversation_analyses(conversation_id);
create index idx_conv_analyses_lead on conversation_analyses(lead_id);

alter table conversation_analyses enable row level security;
create policy "conv_analyses_org_access" on conversation_analyses
  for all using (organization_id = public.get_user_org_id());

-- ═══════════════════════════════════════════════════════════════
-- 3. HIPAA COMPLIANCE AUDIT LOG
-- ═══════════════════════════════════════════════════════════════

create table public.hipaa_audit_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- What happened
  event_type text not null,
  -- 'phi_access', 'phi_transmitted', 'phi_stored', 'phi_deleted',
  -- 'consent_obtained', 'consent_revoked',
  -- 'data_breach_detected', 'encryption_failure',
  -- 'ai_processing', 'ai_phi_scrubbed', 'ai_phi_detected',
  -- 'access_denied', 'unauthorized_attempt',
  -- 'retention_check', 'data_minimization'

  severity text not null default 'info',
  -- 'info', 'warning', 'violation', 'critical'

  -- Who/What
  actor_type text not null, -- 'user', 'system', 'ai_agent', 'cron', 'webhook'
  actor_id text, -- user_id, agent name, etc.

  -- Details
  resource_type text, -- 'lead', 'conversation', 'message', 'patient_profile', 'ai_interaction'
  resource_id text,
  description text not null,

  -- PHI Specifics
  phi_categories jsonb default '[]'::jsonb,
  -- Categories of PHI involved: 'name', 'phone', 'email', 'medical', 'financial', 'insurance', 'ssn', 'dob'

  -- Remediation
  remediation_action text,
  remediation_status text default 'none', -- 'none', 'pending', 'resolved', 'escalated'

  -- Technical
  ip_address text,
  user_agent text,
  metadata jsonb default '{}',

  created_at timestamptz default now()
);

create index idx_hipaa_audit_org on hipaa_audit_log(organization_id, created_at desc);
create index idx_hipaa_audit_severity on hipaa_audit_log(organization_id, severity);
create index idx_hipaa_audit_type on hipaa_audit_log(organization_id, event_type);

alter table hipaa_audit_log enable row level security;
create policy "hipaa_audit_org_access" on hipaa_audit_log
  for all using (organization_id = public.get_user_org_id());

-- ═══════════════════════════════════════════════════════════════
-- 4. UPDATE TRIGGERS
-- ═══════════════════════════════════════════════════════════════

-- Auto-update updated_at on patient_profiles
create or replace function update_patient_profile_timestamp()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trigger_patient_profile_updated
  before update on patient_profiles
  for each row execute function update_patient_profile_timestamp();
