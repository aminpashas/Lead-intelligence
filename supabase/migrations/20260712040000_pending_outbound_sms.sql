-- Deferred (human-paced) outbound SMS queue.
--
-- The AI answers a patient the instant it finishes generating — a few seconds,
-- every time, perfectly on cue. To a patient that reads as a bot: no human reads
-- "really bad" and fires back a formatted reply in three seconds. This queue lets
-- an AI SMS be scheduled a human-ish beat later (read + type time, scaled to the
-- reply length, with jitter) instead of sent inline in the webhook.
--
-- Mirrors the existing outbox+drain pattern (dion_desk_outbox → forward-desk-outbox
-- cron): rows are enqueued with a send_at, a per-minute cron drains the due ones
-- through the same consent-gated sendSMSToLead path, and records the message on the
-- thread only once it actually goes out.
--
-- SAFETY: entirely inert until the per-org `sms_human_pacing` feature flag is ON.
-- With the flag OFF (the default) nothing enqueues here and the send path is the
-- unchanged inline send. Applying this migration alone changes no behavior.

create table if not exists public.pending_outbound_sms (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,

  -- Delivery target (phone) + the message the AI composed.
  to_contact text not null,
  body text not null,

  -- Provenance carried through so the drained message row matches what the inline
  -- path would have written (agent attribution, confidence, action, metadata).
  agent text,
  action_taken text,
  confidence numeric,
  metadata jsonb not null default '{}'::jsonb,

  -- When the message should actually go out. The drain cron sends rows whose
  -- send_at has passed.
  send_at timestamptz not null,

  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'failed', 'canceled')),
  attempts int not null default 0,
  last_error text,
  external_id text,           -- Twilio SID once sent

  created_at timestamptz not null default now(),
  sent_at timestamptz
);

-- The drain scans for due, still-pending rows oldest-first.
create index if not exists idx_pending_outbound_sms_due
  on public.pending_outbound_sms (send_at)
  where status = 'pending';

-- A newer inbound from the same patient should be able to cancel an unsent,
-- now-stale queued reply — look those up by conversation.
create index if not exists idx_pending_outbound_sms_conversation
  on public.pending_outbound_sms (conversation_id, status);

alter table public.pending_outbound_sms enable row level security;

create policy "Users can view pending outbound sms in their org"
  on public.pending_outbound_sms for select using (organization_id = public.get_user_org_id());
create policy "Users can manage pending outbound sms in their org"
  on public.pending_outbound_sms for all using (organization_id = public.get_user_org_id());

comment on table public.pending_outbound_sms is
  'Human-paced outbound SMS queue. Inert unless the org''s sms_human_pacing flag is ON. An AI SMS is enqueued with a send_at a realistic beat in the future; the drain-outbound-sms cron sends due rows through the consent-gated path and records them on the thread only once delivered.';
comment on column public.pending_outbound_sms.send_at is
  'When the message should go out — set to now + a length-scaled, jittered human delay so replies do not all land seconds after the inbound.';
comment on column public.pending_outbound_sms.status is
  'pending → sending (claimed by drain) → sent | failed; canceled when a newer inbound supersedes an unsent reply.';
