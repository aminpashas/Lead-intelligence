-- Migration 003: Conversations and Messages
-- Unified messaging (SMS + Email) with AI tracking

-- ============================================
-- CONVERSATIONS
-- ============================================
create table public.conversations (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,

  channel text not null check (channel in ('sms', 'email', 'web_chat', 'whatsapp')),
  status text default 'active' check (status in ('active', 'paused', 'closed', 'archived')),

  subject text, -- for email threads

  -- AI engagement
  ai_enabled boolean default true, -- AI auto-responds
  ai_mode text default 'assist' check (ai_mode in ('auto', 'assist', 'off')),
  -- auto = AI responds automatically, assist = AI drafts for review, off = manual only

  sentiment text check (sentiment in ('positive', 'neutral', 'negative', 'frustrated')),
  intent text, -- AI-detected intent: "ready_to_book", "price_shopping", "needs_education", etc.

  last_message_at timestamptz,
  last_message_preview text,
  unread_count integer default 0,
  message_count integer default 0,

  metadata jsonb default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_conversations_org on public.conversations(organization_id, last_message_at desc);
create index idx_conversations_lead on public.conversations(lead_id);
create index idx_conversations_channel on public.conversations(organization_id, channel);

-- ============================================
-- MESSAGES
-- ============================================
create table public.messages (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,

  direction text not null check (direction in ('inbound', 'outbound')),
  channel text not null check (channel in ('sms', 'email', 'web_chat', 'whatsapp')),

  -- Content
  body text not null,
  html_body text, -- for email
  subject text, -- for email

  -- Sender info
  sender_type text not null check (sender_type in ('lead', 'user', 'ai', 'system')),
  sender_id uuid, -- user_profiles.id if sent by staff
  sender_name text,

  -- Delivery
  status text default 'pending' check (status in ('pending', 'queued', 'sent', 'delivered', 'read', 'failed', 'bounced')),
  error_message text,

  -- External IDs
  external_id text, -- Twilio SID, Resend ID, etc.

  -- Email-specific
  email_from text,
  email_to text,
  email_cc text[],
  email_attachments jsonb,

  -- AI metadata
  ai_generated boolean default false,
  ai_confidence numeric(3,2), -- 0.00 to 1.00
  ai_model text,
  ai_prompt_tokens integer,
  ai_completion_tokens integer,

  -- Engagement tracking
  opened_at timestamptz,
  clicked_at timestamptz,
  replied_at timestamptz,

  metadata jsonb default '{}',
  created_at timestamptz default now()
);

create index idx_messages_conversation on public.messages(conversation_id, created_at);
create index idx_messages_lead on public.messages(lead_id, created_at desc);
create index idx_messages_org on public.messages(organization_id, created_at desc);
create index idx_messages_external on public.messages(external_id);

-- ============================================
-- AI INTERACTION LOG
-- ============================================
create table public.ai_interactions (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete set null,

  interaction_type text not null check (interaction_type in ('scoring', 'engagement', 'education', 'objection_handling', 'summary', 'classification', 'other')),

  model text not null,
  prompt_tokens integer,
  completion_tokens integer,
  total_tokens integer,
  cost_usd numeric(10,6),
  latency_ms integer,

  input_summary text, -- don't store full PII, just summary
  output_summary text,

  success boolean default true,
  error text,

  metadata jsonb default '{}',
  created_at timestamptz default now()
);

create index idx_ai_interactions_org on public.ai_interactions(organization_id, created_at desc);
create index idx_ai_interactions_lead on public.ai_interactions(lead_id);
create index idx_ai_interactions_type on public.ai_interactions(organization_id, interaction_type);

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.ai_interactions enable row level security;

create policy "Users can view conversations in their org"
  on public.conversations for select
  using (organization_id = public.get_user_org_id());

create policy "Users can manage conversations in their org"
  on public.conversations for all
  using (organization_id = public.get_user_org_id());

create policy "Users can view messages in their org"
  on public.messages for select
  using (organization_id = public.get_user_org_id());

create policy "Users can create messages in their org"
  on public.messages for insert
  with check (organization_id = public.get_user_org_id());

create policy "Users can view AI interactions in their org"
  on public.ai_interactions for select
  using (organization_id = public.get_user_org_id());

create policy "System can insert AI interactions"
  on public.ai_interactions for insert
  with check (organization_id = public.get_user_org_id());

-- ============================================
-- TRIGGERS
-- ============================================
create trigger set_conversations_updated_at
  before update on public.conversations
  for each row execute function public.handle_updated_at();

-- Update conversation stats when message is inserted
create or replace function public.update_conversation_on_message()
returns trigger as $$
begin
  update public.conversations
  set
    last_message_at = new.created_at,
    last_message_preview = left(new.body, 100),
    message_count = message_count + 1,
    unread_count = case
      when new.direction = 'inbound' then unread_count + 1
      else unread_count
    end,
    updated_at = now()
  where id = new.conversation_id;

  -- Update lead engagement metrics
  if new.direction = 'outbound' then
    update public.leads set
      total_messages_sent = total_messages_sent + 1,
      last_contacted_at = new.created_at,
      total_sms_sent = case when new.channel = 'sms' then total_sms_sent + 1 else total_sms_sent end,
      total_emails_sent = case when new.channel = 'email' then total_emails_sent + 1 else total_emails_sent end
    where id = new.lead_id;
  else
    update public.leads set
      total_messages_received = total_messages_received + 1,
      last_responded_at = new.created_at,
      total_sms_received = case when new.channel = 'sms' then total_sms_received + 1 else total_sms_received end
    where id = new.lead_id;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger on_message_insert
  after insert on public.messages
  for each row execute function public.update_conversation_on_message();
