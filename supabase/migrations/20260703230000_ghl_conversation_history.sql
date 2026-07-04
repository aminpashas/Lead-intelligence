-- ════════════════════════════════════════════════════════════════════════════
-- GHL conversation history — mapping key + authoritative aggregate recompute
--
-- Context: the GHL sync mirrors opportunities/stages into LI but has never
-- pulled the two-way conversation history (SMS/email) that lives in GHL. Two
-- new consumers need this migration:
--
--   1. Go-forward capture  — POST /api/webhooks/ghl/message
--   2. Historical backfill — src/lib/ghl/backfill-conversations.ts (+ cron)
--
-- Both attribute a GHL conversation to an LI lead. The fast path is a direct
-- key (leads.ghl_contact_id); the fallback is the existing phone/email search
-- hash. The backfill self-heals the key: when it matches a lead by hash it
-- writes ghl_contact_id back, so subsequent runs and the webhook go direct.
--
-- The recompute functions exist because bulk-inserting historical messages must
-- NOT trust the live counter path (the on_message_insert trigger from mig 003
-- and/or the increment_* RPCs from mig 012 both stamp NOW() and increment — a
-- backfill of year-old messages would either double-count or make every lead
-- look freshly contacted today). Instead the backfill inserts messages plainly
-- and then calls these functions to SET counters from ground truth. Recency
-- fields use GREATEST() so importing OLD messages can never regress a lead's
-- real last_contacted/last_responded (which other channels — voice, campaigns —
-- also maintain).
-- ════════════════════════════════════════════════════════════════════════════

-- ── Mapping key ──────────────────────────────────────────────────────────────
alter table public.leads
  add column if not exists ghl_contact_id text;

-- Partial index: only GHL-linked leads carry the id, so keep the index small.
create index if not exists idx_leads_ghl_contact_id
  on public.leads (ghl_contact_id)
  where ghl_contact_id is not null;

-- ── Authoritative conversation recompute ─────────────────────────────────────
-- Recompute a set of conversations' stats from their messages. Sets
-- unread_count to 0: backfilled history is treated as already-read; genuine
-- unread re-accrues from new live inbounds. last_message_at uses GREATEST so a
-- conversation that also holds newer live messages is never moved backwards.
create or replace function public.recompute_conversation_stats(p_conversation_ids uuid[])
returns void
language sql
security definer
set search_path = public
as $$
  update public.conversations c
  set
    message_count        = sub.cnt,
    last_message_at      = greatest(c.last_message_at, sub.last_at),
    last_message_preview = left(coalesce(sub.last_body, c.last_message_preview), 100),
    unread_count         = 0,
    updated_at           = now()
  from (
    select
      conversation_id,
      count(*)                                              as cnt,
      max(created_at)                                       as last_at,
      (array_agg(body order by created_at desc))[1]         as last_body
    from public.messages
    where conversation_id = any(p_conversation_ids)
    group by conversation_id
  ) sub
  where c.id = sub.conversation_id;
$$;

-- ── Authoritative lead message-aggregate recompute ───────────────────────────
-- Counters are SET from ground truth (the messages table is the single source
-- of truth for these — every insert path bumps them and nothing else does).
-- Recency fields use GREATEST(existing, computed): a backfill of historical
-- messages must never overwrite a newer last_contacted_at that a voice call or
-- campaign send already established.
create or replace function public.recompute_lead_message_stats(p_lead_ids uuid[])
returns void
language sql
security definer
set search_path = public
as $$
  update public.leads l
  set
    total_messages_sent     = s.sent,
    total_messages_received = s.recv,
    total_sms_sent          = s.sms_sent,
    total_sms_received      = s.sms_recv,
    total_emails_sent       = s.email_sent,
    last_contacted_at       = greatest(l.last_contacted_at, s.last_out),
    last_responded_at       = greatest(l.last_responded_at, s.last_in)
  from (
    select
      lead_id,
      count(*) filter (where direction = 'outbound')                        as sent,
      count(*) filter (where direction = 'inbound')                         as recv,
      count(*) filter (where direction = 'outbound' and channel = 'sms')    as sms_sent,
      count(*) filter (where direction = 'inbound'  and channel = 'sms')    as sms_recv,
      count(*) filter (where direction = 'outbound' and channel = 'email')  as email_sent,
      max(created_at) filter (where direction = 'outbound')                 as last_out,
      max(created_at) filter (where direction = 'inbound')                  as last_in
    from public.messages
    where lead_id = any(p_lead_ids)
    group by lead_id
  ) s
  where l.id = s.lead_id;
$$;

comment on column public.leads.ghl_contact_id is
  'GoHighLevel contact id, used to attribute GHL conversation history to this lead. Populated by the reconcile sweep, the conversation webhook, and the history backfill (self-healing from phone/email hash).';
