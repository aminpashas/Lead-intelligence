-- Unified outreach sequences: DB-defined, command-center-editable cadences for
-- (1) new-lead follow-up (speed-to-lead + no-answer touches) and
-- (2) appointment confirmation/reminders — with per-step AI vs human ownership.
--
-- DORMANT-SAFE SHIP:
--  * new_lead_follow_up seeds mirror the hardcoded DEFAULT_FOLLOWUP_SEQUENCE
--    (the cron is still gated by FOLLOWUP_SEQUENCES_ENABLED); extra call steps
--    ship enabled=false.
--  * appointment_prep seeds ship with the SEQUENCE itself enabled=false — the
--    legacy reminders executor keeps running until someone enables it in the
--    Workflows tab, at which point the generic executor takes over.

create table public.outreach_sequences (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  key text not null,
  name text not null,
  description text,
  trigger text not null check (trigger in ('lead_created','appointment')),
  anchor text not null check (anchor in ('enrollment','appointment_time')),
  enabled boolean not null default true,
  is_system boolean not null default false,
  stop_on_reply boolean not null default true,
  stop_on_booking boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, key)
);

create table public.outreach_sequence_steps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  sequence_id uuid not null references public.outreach_sequences(id) on delete cascade,
  position int not null,
  -- Minutes relative to the anchor. Negative = before the appointment.
  offset_minutes int not null default 0,
  channel text not null check (channel in ('sms','email','ai_call','human_call','human_task')),
  owner text not null default 'ai' check (owner in ('ai','human')),
  condition text not null default 'always' check (condition in ('always','unconfirmed','confirmed')),
  -- Guidance for AI composition (or instructions on a human task).
  intent text,
  -- Optional fixed-copy override; when null, AI-owned sms/email are composed
  -- per lead by the setter agent.
  template_subject text,
  template_body text,
  enabled boolean not null default true,
  -- 'speed_to_lead' marks the display/config proxy for the instant first touch
  -- executed by the webhook path; the cron skips it.
  kind text not null default 'step' check (kind in ('step','speed_to_lead')),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sequence_id, position)
);

create index outreach_sequences_org_idx on public.outreach_sequences (organization_id);
create index outreach_sequence_steps_seq_idx on public.outreach_sequence_steps (sequence_id, position);
create index outreach_sequence_steps_org_idx on public.outreach_sequence_steps (organization_id);

create trigger set_outreach_sequences_updated_at
  before update on public.outreach_sequences
  for each row execute function public.handle_updated_at();
create trigger set_outreach_sequence_steps_updated_at
  before update on public.outreach_sequence_steps
  for each row execute function public.handle_updated_at();

alter table public.outreach_sequences enable row level security;
alter table public.outreach_sequence_steps enable row level security;

create policy "Users can view outreach_sequences in their org" on public.outreach_sequences
  for select using (organization_id = get_user_org_id());
create policy "Users can insert outreach_sequences in their org" on public.outreach_sequences
  for insert with check (organization_id = get_user_org_id());
create policy "Users can update outreach_sequences in their org" on public.outreach_sequences
  for update using (organization_id = get_user_org_id());
create policy "Users can delete outreach_sequences in their org" on public.outreach_sequences
  for delete using (organization_id = get_user_org_id());

create policy "Users can view outreach_sequence_steps in their org" on public.outreach_sequence_steps
  for select using (organization_id = get_user_org_id());
create policy "Users can insert outreach_sequence_steps in their org" on public.outreach_sequence_steps
  for insert with check (organization_id = get_user_org_id());
create policy "Users can update outreach_sequence_steps in their org" on public.outreach_sequence_steps
  for update using (organization_id = get_user_org_id());
create policy "Users can delete outreach_sequence_steps in their org" on public.outreach_sequence_steps
  for delete using (organization_id = get_user_org_id());

-- Which sequence an enrollment follows (null = the org's new_lead_follow_up).
alter table public.follow_up_enrollments
  add column if not exists sequence_id uuid references public.outreach_sequences(id) on delete set null;

-- ── Seeds (per existing org, behavior-preserving) ────────────────────

-- 1) New-lead outreach: position 0 is the speed-to-lead proxy; enabled steps
--    mirror DEFAULT_FOLLOWUP_SEQUENCE (day 1/2/4/7/10/14 email+sms); the new
--    call touches ship disabled.
with seqs as (
  insert into public.outreach_sequences
    (organization_id, key, name, description, trigger, anchor, is_system, enabled)
  select id, 'new_lead_follow_up', 'New Lead Outreach',
         'Instant AI first touch on form fill, then a no-answer cadence of texts, emails and calls. Stops when the lead replies or books.',
         'lead_created', 'enrollment', true, true
  from public.organizations
  on conflict (organization_id, key) do nothing
  returning id, organization_id
)
insert into public.outreach_sequence_steps
  (organization_id, sequence_id, position, offset_minutes, channel, owner, intent, enabled, kind)
select s.organization_id, s.id, t.position, t.offset_minutes, t.channel, t.owner, t.intent, t.enabled, t.kind
from seqs s
cross join (values
  (0,     0, 'sms',        'ai',    'Instant AI first touch — personalized intro the moment the lead fills the form.', true,  'speed_to_lead'),
  (1,     5, 'ai_call',    'ai',    'Immediate call attempt right after the first text: introduce the practice, qualify, offer to book a consult.', false, 'step'),
  (2,  1440, 'email',      'ai',    'Day-1 follow-up email: recap value, invite to book a free consultation.', true,  'step'),
  (3,  1560, 'human_call', 'human', 'Manual call attempt — no response to the first text or email yet.', false, 'step'),
  (4,  2880, 'sms',        'ai',    'Day-2 text nudge: keep it short, ask if they still want to explore treatment.', true,  'step'),
  (5,  4320, 'ai_call',    'ai',    'Day-3 call attempt: answer questions, mention financing options, offer times.', false, 'step'),
  (6,  5760, 'email',      'ai',    'Day-4 email: address common hesitations (cost, fear), include social proof.', true,  'step'),
  (7, 10080, 'sms',        'ai',    'Day-7 text: check in, offer to answer questions or book when ready.', true,  'step'),
  (8, 14400, 'email',      'ai',    'Day-10 email: last value-add touch before the breakup message.', true,  'step'),
  (9, 20160, 'email',      'ai',    'Day-14 breakup email: door stays open, easy way to re-engage.', true,  'step'),
  (10,20170, 'sms',        'ai',    'Day-14 breakup text: final short goodbye with an easy YES to restart.', true,  'step')
) as t(position, offset_minutes, channel, owner, intent, enabled, kind)
on conflict (sequence_id, position) do nothing;

-- 2) Appointment confirmation & reminders (anchored to the appointment time;
--    negative offsets = before). Sequence ships DISABLED: the legacy 72h/24h
--    reminder executor keeps running until this is enabled in the UI.
with seqs as (
  insert into public.outreach_sequences
    (organization_id, key, name, description, trigger, anchor, is_system, enabled, stop_on_reply, stop_on_booking)
  select id, 'appointment_prep', 'Appointment Confirmation & Reminders',
         'Confirmation asks and reminders around each scheduled appointment: what to send, when to text vs call, and who (AI or staff) owns each touch.',
         'appointment', 'appointment_time', true, false, false, false
  from public.organizations
  on conflict (organization_id, key) do nothing
  returning id, organization_id
)
insert into public.outreach_sequence_steps
  (organization_id, sequence_id, position, offset_minutes, channel, owner, condition, intent, enabled, metadata)
select s.organization_id, s.id, t.position, t.offset_minutes, t.channel, t.owner, t.condition, t.intent, t.enabled, t.metadata::jsonb
from seqs s
cross join (values
  (0, -4320, 'email',      'ai',    'always',      'Appointment details + confirm button, 72 hours out.', true,  '{"legacy":"72h"}'),
  (1, -2880, 'ai_call',    'ai',    'unconfirmed', 'Still unconfirmed 48h out — call to confirm, offer reschedule if needed.', false, '{}'),
  (2, -1440, 'sms',        'ai',    'always',      '24-hour reminder text with confirm link.', true,  '{"legacy":"24h_sms"}'),
  (3, -1440, 'email',      'ai',    'always',      '24-hour reminder email with details and directions.', true,  '{"legacy":"24h_email"}'),
  (4,  -120, 'ai_call',    'ai',    'unconfirmed', 'Confirmation call 2 hours before: confirm attendance, handle reschedules.', true,  '{"legacy":"2h_call"}'),
  (5,   -60, 'sms',        'ai',    'unconfirmed', 'Final nudge 1 hour before if still unconfirmed.', true,  '{"legacy":"1h_sms"}')
) as t(position, offset_minutes, channel, owner, condition, intent, enabled, metadata)
on conflict (sequence_id, position) do nothing;
