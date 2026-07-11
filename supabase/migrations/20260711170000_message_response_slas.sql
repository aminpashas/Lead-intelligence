-- Workstream D3: 3-minute human-response SLA takeover.
--
-- WHAT: one row per inbound lead message = the first-response metrics store +
-- the takeover timer for 'hold' allocations (D1 resolveAutomationOwner).
--
-- Two lanes write here:
--   * AI lane   — allocation said 'ai' and the AI replied immediately:
--                 status 'ai_immediate', responder_type 'ai', sla_met true.
--                 Pure metrics; no timer ever runs.
--   * Hold lane — allocation said 'hold' (human-first with an SLA): status
--                 'pending' with deadline_at = inbound_at + sla_seconds.
--                 The sla-takeover cron sweeps expired pendings and either
--                 confirms a human already replied ('human_responded'), lets
--                 the AI take over ('ai_takeover'), or records the breach
--                 ('expired' + takeover_error + an sla_breach_review task).
--
-- Burst collapse: ONE pending row per conversation (partial unique index). A
-- second inbound before anyone responds refreshes takeover_payload on the
-- existing row but keeps the original inbound_at/deadline_at — the clock
-- starts at the first unanswered inbound.
--
-- Writes are service-role only (webhooks / cron / API routes using the
-- service client); authenticated users get org-scoped read for dashboards.

create table public.message_response_slas (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  inbound_message_id uuid references public.messages(id) on delete set null,
  inbound_at timestamptz not null default now(),
  sla_seconds int not null default 180,
  deadline_at timestamptz not null,
  status text not null default 'pending' check (status in (
    'pending','human_responded','ai_takeover','ai_immediate','cancelled','expired')),
  first_response_at timestamptz,
  responder_type text check (responder_type in ('human','ai')),
  sla_met boolean,
  -- Everything the takeover cron needs to re-run processAutoResponse later
  -- (channel, inbound_message, sender_contact, ids). Lead/conversation rows
  -- are reloaded fresh at takeover time so gates see current state.
  takeover_payload jsonb not null default '{}'::jsonb,
  takeover_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Cron sweep: expired pendings in deadline order.
create index message_response_slas_pending_deadline_idx
  on public.message_response_slas (deadline_at)
  where status = 'pending';

-- Burst collapse: one live timer per conversation. Terminal rows fall out of
-- the index, so history (metrics) is preserved.
create unique index message_response_slas_pending_convo_uniq
  on public.message_response_slas (conversation_id)
  where status = 'pending';

-- Org-scoped reporting reads (first-response dashboards).
create index message_response_slas_org_created_idx
  on public.message_response_slas (organization_id, created_at);

alter table public.message_response_slas enable row level security;

-- Org-scoped SELECT only. No insert/update/delete policies for authenticated
-- users: all writes come from the service-role client (webhooks, the
-- sla-takeover cron, and staff-send API routes), which bypasses RLS.
create policy "Users can view message_response_slas in their org"
  on public.message_response_slas
  for select using (organization_id = get_user_org_id());
