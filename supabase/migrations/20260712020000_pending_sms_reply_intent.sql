-- Pending SMS reply intent — disambiguate which workflow a lead's "YES" answers.
--
-- Two-way SMS has multiple flows that all solicit a bare "YES": appointment
-- reminders ("Reply YES to confirm"), the financing denial follow-up ("Reply YES
-- or call us" about in-house payment plans), and mass re-engagement blasts. The
-- inbound webhook previously treated EVERY "YES" as an appointment confirmation,
-- so a YES meant for the financing follow-up silently confirmed the next upcoming
-- appointment instead — two workflows colliding on a shared token.
--
-- This table is the missing primitive: the moment an outbound message asks for a
-- reply, the sender stamps the *intent* it expects. When the lead answers, the
-- webhook reads the intent and routes the reply to the right workflow (appointment
-- confirm vs financing vs the AI responder). One live intent per (lead, channel);
-- a fresh solicitation overwrites the previous one, and consuming it clears it.

create table if not exists public.pending_sms_reply_intents (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,

  channel text not null default 'sms' check (channel in ('sms')),

  -- Which workflow solicited the reply and is therefore owed the "YES".
  intent text not null check (intent in (
    'appointment_confirm',   -- appointment reminder ("Reply YES to confirm")
    'financing_followup',    -- financing denial follow-up ("Reply YES or call us")
    'mass_sms'               -- generic mass/re-engagement blast
  )),

  -- Optional pointer to the concrete record the intent is about, so the handler
  -- confirms the RIGHT appointment rather than "the next upcoming one".
  ref_type text check (ref_type in ('appointment', 'financing_application', 'campaign')),
  ref_id uuid,

  created_at timestamptz not null default now(),
  -- Intents are ephemeral. After this, a "YES" no longer belongs to the flow and
  -- falls through to the AI responder instead of firing a stale workflow.
  expires_at timestamptz not null default (now() + interval '72 hours'),

  -- One live intent per lead per channel: a new solicitation replaces the old one.
  unique (lead_id, channel)
);

-- The webhook looks up by (lead_id, channel) filtering on expiry on every inbound
-- affirmative — keep it a single-row index hit.
create index if not exists idx_pending_sms_reply_intents_lookup
  on public.pending_sms_reply_intents (lead_id, channel, expires_at);

alter table public.pending_sms_reply_intents enable row level security;

create policy "Users can view pending sms intents in their org"
  on public.pending_sms_reply_intents for select using (organization_id = public.get_user_org_id());
create policy "Users can manage pending sms intents in their org"
  on public.pending_sms_reply_intents for all using (organization_id = public.get_user_org_id());

comment on table public.pending_sms_reply_intents is
  'One live "we asked this lead for a reply" marker per (lead, channel). Set when an outbound SMS solicits a YES; read + cleared by the inbound webhook to route the reply to the correct workflow instead of assuming every YES confirms an appointment.';
comment on column public.pending_sms_reply_intents.intent is
  'The workflow that solicited the reply: appointment_confirm | financing_followup | mass_sms.';
comment on column public.pending_sms_reply_intents.ref_id is
  'Concrete record the intent points at (e.g. the appointment to confirm), so the handler acts on the right row rather than the next upcoming one.';
