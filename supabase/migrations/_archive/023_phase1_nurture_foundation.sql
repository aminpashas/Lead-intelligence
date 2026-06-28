-- Migration 023: Phase 1 Nurture Foundation
-- Adds:
--   1. consent_log     — append-only TCPA/CAN-SPAM audit trail
--                       (existing leads.*_consent / *_opt_out columns stay; this adds the audit history)
--   2. events          — append-only system event log (queue source for CAPI/Google Ads forwarders)
--   3. dormant status  — adds 'dormant' to leads.status CHECK constraint for the 60-day sweep
--   4. consent trigger — auto-appends to consent_log whenever leads consent/opt-out fields change
--
-- See plan: ~/.claude/plans/woolly-tumbling-kite.md (Phase 1, section 1.1)
-- Brief:   ~/Desktop/Dion_Health_Lead_Intelligence_Connector_Brief.docx (Section 2.1)

-- ============================================
-- 1. CONSENT_LOG (audit trail)
-- ============================================
create table public.consent_log (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,

  channel text not null check (channel in ('sms', 'email', 'voice')),
  consent_given boolean not null,           -- true = grant, false = revoke
  granted_at timestamptz,                   -- set when consent_given = true
  revoked_at timestamptz,                   -- set when consent_given = false

  source text,                              -- 'form', 'qualify_form', 'manual', 'import', 'inbound_stop', 'webhook', 'system'
  source_text text,                         -- the actual consent language shown to the lead, or the inbound STOP message
  ip_address inet,                          -- captured at form submit time when available
  user_agent text,
  actor_user_id uuid references public.user_profiles(id), -- staff member if manual change

  metadata jsonb default '{}',
  created_at timestamptz default now()
);

create index idx_consent_log_lead on public.consent_log(lead_id, created_at desc);
create index idx_consent_log_org on public.consent_log(organization_id, created_at desc);
create index idx_consent_log_org_channel on public.consent_log(organization_id, channel, created_at desc);

comment on table public.consent_log is 'Append-only TCPA/CAN-SPAM audit trail. State of record lives on leads.{sms,email,voice}_consent + *_opt_out columns; this table holds the change history.';

-- ============================================
-- 2. EVENTS (append-only system log)
-- ============================================
create table public.events (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete cascade,  -- nullable: not all events are lead-scoped

  event_type text not null,                 -- 'lead.created', 'lead.booking.created', 'lead.treatment_accepted', 'consent_violation_prevented', etc.
  payload jsonb default '{}',

  -- Forwarder bookkeeping (used by Phase 2 CAPI / Google Ads forwarders)
  capi_status text default 'pending' check (capi_status in ('pending', 'sent', 'failed', 'skipped', 'na')),
  capi_attempted_at timestamptz,
  gads_status text default 'pending' check (gads_status in ('pending', 'sent', 'failed', 'skipped', 'na')),
  gads_attempted_at timestamptz,

  occurred_at timestamptz not null default now(),
  created_at timestamptz default now()
);

create index idx_events_org_occurred on public.events(organization_id, occurred_at desc);
create index idx_events_org_type on public.events(organization_id, event_type, occurred_at desc);
create index idx_events_lead on public.events(lead_id, occurred_at desc) where lead_id is not null;
-- Forwarder pickup indexes — partial indexes keep them small
create index idx_events_capi_pending on public.events(occurred_at) where capi_status = 'pending';
create index idx_events_gads_pending on public.events(occurred_at) where gads_status = 'pending';

comment on table public.events is 'Append-only system event log. Source-of-truth queue for downstream forwarders (Meta CAPI, Google Ads, analytics). Distinct from lead_activities (UI activity feed) and connector_events (per-dispatch outcome log).';

-- ============================================
-- 3. ADD 'dormant' TO leads.status
-- ============================================
-- Postgres requires dropping and recreating CHECK constraints to extend them.
-- The constraint name 'leads_status_check' is the default Postgres assigns to inline CHECK on 'status'.
alter table public.leads drop constraint if exists leads_status_check;
alter table public.leads add constraint leads_status_check
  check (status in (
    'new', 'contacted', 'qualified',
    'consultation_scheduled', 'consultation_completed',
    'treatment_presented', 'financing',
    'contract_sent', 'contract_signed',
    'scheduled', 'in_treatment', 'completed',
    'lost', 'disqualified', 'no_show', 'unresponsive',
    'dormant'  -- NEW: 60-day inactivity sweep target
  ));

-- Activity index needed by the dormant sweep (last_contacted_at + last_responded_at exist on leads)
create index if not exists idx_leads_org_last_contacted on public.leads(organization_id, last_contacted_at)
  where status not in ('completed', 'lost', 'disqualified', 'dormant');

-- ============================================
-- 4. CONSENT TRIGGER
--    Auto-append a consent_log row whenever consent/opt-out columns change on leads.
-- ============================================
create or replace function public.log_consent_change()
returns trigger as $$
begin
  -- SMS consent grant
  if (tg_op = 'INSERT' and new.sms_consent = true)
     or (tg_op = 'UPDATE' and coalesce(old.sms_consent, false) is distinct from new.sms_consent and new.sms_consent = true) then
    insert into public.consent_log (organization_id, lead_id, channel, consent_given, granted_at, source, source_text)
    values (new.organization_id, new.id, 'sms', true, coalesce(new.sms_consent_at, now()), new.sms_consent_source, null);
  end if;

  -- SMS opt-out (revoke)
  if (tg_op = 'UPDATE' and coalesce(old.sms_opt_out, false) is distinct from new.sms_opt_out and new.sms_opt_out = true) then
    insert into public.consent_log (organization_id, lead_id, channel, consent_given, revoked_at, source)
    values (new.organization_id, new.id, 'sms', false, coalesce(new.sms_opt_out_at, now()), 'inbound_stop');
  end if;

  -- Email consent grant
  if (tg_op = 'INSERT' and new.email_consent = true)
     or (tg_op = 'UPDATE' and coalesce(old.email_consent, false) is distinct from new.email_consent and new.email_consent = true) then
    insert into public.consent_log (organization_id, lead_id, channel, consent_given, granted_at, source)
    values (new.organization_id, new.id, 'email', true, coalesce(new.email_consent_at, now()), new.email_consent_source);
  end if;

  -- Email opt-out (revoke)
  if (tg_op = 'UPDATE' and coalesce(old.email_opt_out, false) is distinct from new.email_opt_out and new.email_opt_out = true) then
    insert into public.consent_log (organization_id, lead_id, channel, consent_given, revoked_at, source)
    values (new.organization_id, new.id, 'email', false, coalesce(new.email_opt_out_at, now()), 'unsubscribe');
  end if;

  return new;
end;
$$ language plpgsql security definer;

create trigger log_lead_consent_change
  after insert or update of sms_consent, sms_opt_out, email_consent, email_opt_out
  on public.leads
  for each row execute function public.log_consent_change();

-- ============================================
-- 5. EXTEND connector_configs FOR CAL.COM
--    Cal.com per-org credentials (api key, webhook secret, event-type IDs) live here.
-- ============================================
alter table public.connector_configs drop constraint if exists connector_configs_connector_type_check;
alter table public.connector_configs add constraint connector_configs_connector_type_check
  check (connector_type in (
    'google_ads', 'meta_capi', 'ga4', 'outbound_webhook', 'slack', 'google_reviews', 'callrail',
    'cal_com'  -- NEW: Cal.com booking integration
  ));

-- ============================================
-- 6. RLS
-- ============================================
alter table public.consent_log enable row level security;
alter table public.events enable row level security;

create policy "Users can view consent log in their org"
  on public.consent_log for select using (organization_id = public.get_user_org_id());
-- INSERT happens via trigger (security definer) and service role — no user policy needed.

create policy "Users can view events in their org"
  on public.events for select using (organization_id = public.get_user_org_id());
create policy "Users can insert events in their org"
  on public.events for insert with check (organization_id = public.get_user_org_id());
-- UPDATE on events restricted to forwarder service role (no user policy = denied for authenticated users).
