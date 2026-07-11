-- Clinical encounter follow-up briefs (Dion Clinical → Lead Intelligence)
-- ========================================================================
-- The return half of the appointment-summary loop. Dion Clinical runs the
-- ambient scribe; when a visit is summarized it emits `clinical.scribe_completed`
-- (encounterId + noteId, refs only — the SOAP body never rides the bus). The hub
-- fans that event to LI's new /api/bus/receive, which then PULLS a curated,
-- PHI-bounded follow-up brief from Dion Clinical's read endpoint and lands it
-- here + on the lead so the closer agent / closing board can act on the visit
-- outcome.
--
-- Ownership boundary (ECOSYSTEM.md): Dion Clinical owns the chart/EMR + scribe.
-- LI stores only the sales-follow-up-relevant OUTCOME (assessment + plan gist,
-- finding severities), never the full clinical record. The narrative that does
-- land here is internal — it must not be disclosed to the patient in outbound
-- messages (gated on the closer agent via disclose_phi).

-- ── Inbound bus inbox (LI's first inbound bus surface) ──────────────────────
-- Idempotency + durability for events the hub delivers. Keyed on the envelope
-- id so a redelivery is a no-op. `processed_at`/`process_error` let a reprocess
-- pass retry a brief pull that failed transiently without dropping the event.
create table if not exists public.dion_inbox (
  id             text primary key,               -- envelope id (dedupe key)
  type           text not null,
  source         text not null,
  payload        jsonb not null default '{}'::jsonb,
  received_at    timestamptz not null default now(),
  processed_at   timestamptz,
  process_error  text
);

-- Reprocess scan: unprocessed events, oldest first.
create index if not exists idx_dion_inbox_pending
  on public.dion_inbox (received_at)
  where processed_at is null;

-- Service-role-only (the receiver writes with the service key, bypassing RLS).
-- RLS enabled with NO policies => no authenticated/anon access.
alter table public.dion_inbox enable row level security;

comment on table public.dion_inbox is
  'Inbound Dion bus events delivered to LI /api/bus/receive. Idempotent on envelope id. IDs/refs only, no PHI. Service-role only.';

-- ── Encounter follow-up briefs ──────────────────────────────────────────────
create table if not exists public.lead_encounter_briefs (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null,
  lead_id                uuid references public.leads(id) on delete set null,
  encounter_id           text not null,           -- Dion Clinical encounter id
  dion_patient_id        text,                    -- suite-wide patient identity
  external_case_id       text,                    -- LI clinical_cases.id (the bridge back)
  encounter_status       text,                    -- open | completed | cancelled
  note_status            text,                    -- draft | final | amended
  outcome                text,                    -- derived short label (e.g. summarized)
  summary                text,                    -- INTERNAL: assessment + plan gist
  findings               jsonb not null default '[]'::jsonb,  -- [{kind, severity}] signal only
  recommended_follow_up_at timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  -- One brief per encounter per org; a redelivered event upserts, not duplicates.
  unique (organization_id, encounter_id)
);

create index if not exists idx_lead_encounter_briefs_lead
  on public.lead_encounter_briefs (lead_id, created_at desc)
  where lead_id is not null;

-- Readable by org staff (lead detail / closing board can show visit outcome);
-- only the service role writes. Mirrors the leads-table tenant scoping.
alter table public.lead_encounter_briefs enable row level security;
create policy lead_encounter_briefs_tenant_read on public.lead_encounter_briefs
  for select using (organization_id = public.get_user_org_id());

comment on table public.lead_encounter_briefs is
  'Curated, PHI-bounded follow-up briefs pulled from Dion Clinical after a visit is scribed. summary is INTERNAL clinical narrative — never disclose to the patient.';

-- ── Lead denormalization ────────────────────────────────────────────────────
-- The closer agent + closing board read the lead row directly, so surface the
-- latest visit outcome there. dion_patient_id backfills the identity link so a
-- later consult-only encounter (no CRM case) still resolves to this lead.
alter table public.leads
  add column if not exists dion_patient_id text,
  add column if not exists appointment_summary text,
  add column if not exists last_encounter_brief_at timestamptz;

comment on column public.leads.appointment_summary is
  'INTERNAL latest-visit outcome (assessment + plan gist) from Dion Clinical scribe. Steers follow-ups; do NOT disclose clinical specifics to the patient.';
comment on column public.leads.dion_patient_id is
  'Suite-wide Dion patient identity, backfilled when a clinical encounter brief matches this lead. Used to resolve consult-only encounters with no CRM case.';

create index if not exists idx_leads_dion_patient_id
  on public.leads (organization_id, dion_patient_id)
  where dion_patient_id is not null;
