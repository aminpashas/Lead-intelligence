-- Migration: AI-Generated Patient Treatment Contracts
-- Tables for per-org contract templates, patient contracts (draft → signed → executed),
-- contract event timeline, and legal settings defaults.
-- Trigger: clinical_cases.patient_accepted_at transitioning non-null creates the draft.

-- ============================================
-- 1. CONTRACT TEMPLATES (per-org, versioned)
-- ============================================
create table if not exists public.contract_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  name text not null,
  slug text not null,
  version integer not null default 1,

  -- Ordered array of sections. Each section:
  --   id:             stable string id (tool-input key)
  --   title:          heading (e.g. "Treatment Phases")
  --   kind:           'boilerplate' | 'ai_narrative' | 'data_table' | 'consent' | 'signature'
  --   body:           for boilerplate/consent — attorney-authored text with {{variable}} tokens
  --   ai_prompt:      for ai_narrative — instruction telling Claude what to write for this section
  --   max_ai_words:   soft word cap per section
  --   consent_key:    for consent — stable identifier used on the signing audit trail
  --   data_source:    for data_table — 'treatment_plan.phases' | 'financial.summary'
  --   required:       required to render
  sections jsonb not null default '[]',

  -- Variables the template expects in the merge context. Pre-flight validation
  -- fails fast before spending on Claude when keys are missing.
  required_variables text[] not null default '{}',

  status text not null default 'draft'
    check (status in ('draft', 'published', 'archived')),
  published_at timestamptz,
  published_by uuid references auth.users(id),

  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_contract_templates_active
  on public.contract_templates(organization_id, slug)
  where status = 'published';
create index if not exists idx_contract_templates_org on public.contract_templates(organization_id);

alter table public.contract_templates enable row level security;

drop policy if exists "org_members_read_contract_templates" on public.contract_templates;
create policy "org_members_read_contract_templates"
  on public.contract_templates for select
  using (organization_id in (select organization_id from public.user_profiles where id = auth.uid()));

drop policy if exists "admins_manage_contract_templates" on public.contract_templates;
create policy "admins_manage_contract_templates"
  on public.contract_templates for all
  using (
    organization_id in (select organization_id from public.user_profiles where id = auth.uid())
    and exists (
      select 1 from public.user_profiles
      where id = auth.uid()
        and role in ('doctor_admin', 'office_manager', 'owner', 'admin')
    )
  );

drop policy if exists "service_role_manage_contract_templates" on public.contract_templates;
create policy "service_role_manage_contract_templates"
  on public.contract_templates for all using (true);

drop trigger if exists set_contract_templates_updated_at on public.contract_templates;
create trigger set_contract_templates_updated_at
  before update on public.contract_templates
  for each row execute function public.handle_updated_at();

-- ============================================
-- 2. PATIENT CONTRACTS
-- ============================================
create table if not exists public.patient_contracts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  clinical_case_id uuid not null references public.clinical_cases(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete set null,
  treatment_closing_id uuid references public.treatment_closings(id) on delete set null,
  case_treatment_plan_id uuid references public.case_treatment_plans(id) on delete set null,

  template_id uuid references public.contract_templates(id) on delete set null,
  template_version integer not null,
  template_snapshot jsonb not null,

  -- Rendered content: [{ section_id, title, kind, rendered_text, rendered_html, ai_generated }]
  generated_content jsonb not null default '[]',
  -- Variable map used for rendering (for audit replay)
  context_snapshot jsonb not null default '{}',

  status text not null default 'draft'
    check (status in (
      'draft',
      'pending_review',
      'changes_requested',
      'approved',
      'sent',
      'viewed',
      'signed',
      'executed',
      'declined',
      'expired',
      'voided'
    )),
  needs_manual_draft boolean not null default false,

  reviewer_id uuid references auth.users(id),
  review_notes text,
  reviewed_at timestamptz,
  approved_at timestamptz,

  share_token uuid not null default gen_random_uuid(),
  share_token_expires_at timestamptz,
  sent_at timestamptz,
  sent_via text check (sent_via in ('email', 'sms', 'email+sms', 'portal_only')),
  first_viewed_at timestamptz,

  signed_at timestamptz,
  signer_name text,
  signer_ip inet,
  signer_user_agent text,
  signature_data_url text,
  signature_type text check (signature_type in ('drawn', 'typed')),
  consents_agreed jsonb default '[]',

  draft_pdf_storage_path text,
  executed_pdf_storage_path text,
  executed_pdf_sha256 text,

  contract_amount numeric(10,2),
  deposit_amount numeric(10,2),
  financing_type text,
  financing_monthly_payment numeric(10,2),

  ai_model text,
  ai_tokens_in integer,
  ai_tokens_out integer,
  ai_cost_cents numeric(10,2),

  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_patient_contracts_org_status on public.patient_contracts(organization_id, status);
create index if not exists idx_patient_contracts_case on public.patient_contracts(clinical_case_id);
create unique index if not exists idx_patient_contracts_share_token on public.patient_contracts(share_token);
create index if not exists idx_patient_contracts_lead on public.patient_contracts(lead_id) where lead_id is not null;

alter table public.patient_contracts enable row level security;

drop policy if exists "org_members_read_contracts" on public.patient_contracts;
create policy "org_members_read_contracts"
  on public.patient_contracts for select
  using (organization_id in (select organization_id from public.user_profiles where id = auth.uid()));

drop policy if exists "clinical_staff_insert_contracts" on public.patient_contracts;
create policy "clinical_staff_insert_contracts"
  on public.patient_contracts for insert
  with check (organization_id in (select organization_id from public.user_profiles where id = auth.uid()));

drop policy if exists "approvers_manage_contracts" on public.patient_contracts;
create policy "approvers_manage_contracts"
  on public.patient_contracts for update
  using (
    organization_id in (select organization_id from public.user_profiles where id = auth.uid())
    and exists (
      select 1 from public.user_profiles
      where id = auth.uid()
        and role in ('doctor_admin', 'office_manager', 'treatment_coordinator', 'owner', 'admin')
    )
  );

drop policy if exists "service_role_manage_contracts" on public.patient_contracts;
create policy "service_role_manage_contracts"
  on public.patient_contracts for all using (true);

-- Executed contracts are immutable — block any further UPDATE/DELETE once signed
create or replace function public.enforce_contract_immutability()
returns trigger as $$
begin
  if old.status = 'executed' then
    if new.executed_pdf_storage_path is distinct from old.executed_pdf_storage_path
       or new.executed_pdf_sha256 is distinct from old.executed_pdf_sha256
       or new.signature_data_url is distinct from old.signature_data_url
       or new.signed_at is distinct from old.signed_at
       or new.signer_name is distinct from old.signer_name
       or (new.status <> 'executed') then
      raise exception 'executed contracts are immutable';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_contract_immutability on public.patient_contracts;
create trigger trg_contract_immutability
  before update on public.patient_contracts
  for each row execute function public.enforce_contract_immutability();

drop trigger if exists set_patient_contracts_updated_at on public.patient_contracts;
create trigger set_patient_contracts_updated_at
  before update on public.patient_contracts
  for each row execute function public.handle_updated_at();

-- ============================================
-- 3. CONTRACT EVENTS (timeline)
-- ============================================
create table if not exists public.contract_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contract_id uuid not null references public.patient_contracts(id) on delete cascade,
  event_type text not null,
  actor_type text not null default 'user'
    check (actor_type in ('user', 'patient', 'system', 'ai_agent')),
  actor_id text,
  payload jsonb default '{}',
  created_at timestamptz not null default now()
);

create index if not exists idx_contract_events_contract
  on public.contract_events(contract_id, created_at desc);
create index if not exists idx_contract_events_org
  on public.contract_events(organization_id, created_at desc);

alter table public.contract_events enable row level security;

drop policy if exists "org_read_contract_events" on public.contract_events;
create policy "org_read_contract_events"
  on public.contract_events for select
  using (organization_id in (select organization_id from public.user_profiles where id = auth.uid()));

drop policy if exists "service_role_write_contract_events" on public.contract_events;
create policy "service_role_write_contract_events"
  on public.contract_events for all using (true);

-- ============================================
-- 4. LEGAL + CONTRACT SETTINGS DEFAULTS
-- ============================================
-- Expected shape under organizations.settings:
-- {
--   "legal": {
--     "entity_name":              string | null,
--     "state_of_formation":       string | null,      -- "CA", "TX", ...
--     "license_numbers":          { "CA": "DDS-..." },
--     "principal_address":        { street, city, state, zip } | null,
--     "attorney_contact":         { name, email, phone } | null,
--     "arbitration_venue":        string | null,       -- "Los Angeles County, California"
--     "cancellation_policy_days": integer,             -- default 3
--     "refund_policy_days":       integer,             -- default 30
--     "governing_law":            string | null,       -- "State of California"
--     "esign_disclosure_version": string               -- "v1-2026"
--   },
--   "contracts": {
--     "signature_type_allowed":   ["drawn","typed"],
--     "send_method_default":      "email",
--     "share_token_expiry_days":  integer,             -- default 30
--     "auto_draft_on_ehr_accept": boolean              -- default true
--   }
-- }
update public.organizations
set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object(
  'legal', coalesce(settings->'legal', '{}'::jsonb) || jsonb_build_object(
    'cancellation_policy_days', coalesce((settings->'legal'->>'cancellation_policy_days')::int, 3),
    'refund_policy_days',       coalesce((settings->'legal'->>'refund_policy_days')::int, 30),
    'arbitration_venue',        settings->'legal'->'arbitration_venue',
    'governing_law',            settings->'legal'->'governing_law',
    'entity_name',              settings->'legal'->'entity_name',
    'state_of_formation',       settings->'legal'->'state_of_formation',
    'license_numbers',          coalesce(settings->'legal'->'license_numbers', '{}'::jsonb),
    'principal_address',        settings->'legal'->'principal_address',
    'attorney_contact',         settings->'legal'->'attorney_contact',
    'esign_disclosure_version', coalesce(settings->'legal'->>'esign_disclosure_version', 'v1-2026')
  ),
  'contracts', coalesce(settings->'contracts', '{}'::jsonb) || jsonb_build_object(
    'signature_type_allowed',   coalesce(settings->'contracts'->'signature_type_allowed', '["drawn","typed"]'::jsonb),
    'send_method_default',      coalesce(settings->'contracts'->>'send_method_default', 'email'),
    'share_token_expiry_days',  coalesce((settings->'contracts'->>'share_token_expiry_days')::int, 30),
    'auto_draft_on_ehr_accept', coalesce((settings->'contracts'->>'auto_draft_on_ehr_accept')::boolean, true)
  )
);

-- ============================================
-- 5. SEED DEFAULT TEMPLATE FOR EVERY ORG
-- ============================================
insert into public.contract_templates (
  organization_id, name, slug, version, status,
  sections, required_variables, published_at
)
select
  o.id,
  'Implant Treatment Services Agreement',
  'implant-services-agreement',
  1,
  'published',
  '[
    {"id":"parties","title":"Parties","kind":"boilerplate","required":true,
     "body":"This Implant Treatment Services Agreement (\"Agreement\") is entered into between {{legal.entity_name}}, a {{legal.state_of_formation}} professional entity with its principal office at {{legal.principal_address_oneline}} (\"Practice\"), and {{patient.full_name}} (\"Patient\"), effective {{today}}."},
    {"id":"scope_summary","title":"Scope of Treatment","kind":"ai_narrative","required":true,"max_ai_words":180,
     "ai_prompt":"Write 2-3 sentences summarizing, in plain language, what treatment the Patient has agreed to. Reference the chief complaint and the general nature of the phases, but DO NOT restate specific procedure codes, tooth numbers, or dollar amounts — those appear in the Phases table. Do not make medical claims or guarantees."},
    {"id":"phases_table","title":"Treatment Phases","kind":"data_table","required":true,
     "body":"The following treatment phases are included in this Agreement. Patient acknowledges receiving a copy of the full treatment plan prior to signing.","data_source":"treatment_plan.phases"},
    {"id":"preop_instructions","title":"Pre-Operative Instructions","kind":"ai_narrative","required":true,"max_ai_words":220,
     "ai_prompt":"Write Patient-facing pre-operative instructions appropriate for implant surgery. Cover: fasting requirements if sedation is involved, medication adjustments to discuss with prescribing doctor, smoking/alcohol cessation window, transportation arrangement. Use second person. Do NOT reference specific medications by name or dosage — say \"as directed by your prescribing provider.\" Do NOT diagnose or promise outcomes."},
    {"id":"procedure_instructions","title":"Day-of-Procedure","kind":"ai_narrative","required":true,"max_ai_words":150,
     "ai_prompt":"Explain what the Patient should expect on the day of surgery, in 3-5 short paragraphs or bullet-style sentences. Include arrival time, check-in, anesthesia overview (generic, no drug names), and typical duration of the procedure. No guarantees of outcome."},
    {"id":"postop_instructions","title":"Post-Operative Instructions","kind":"ai_narrative","required":true,"max_ai_words":220,
     "ai_prompt":"Write post-operative instructions covering: swelling/bruising expectations (typical, not guaranteed), diet restrictions for 48-72 hours, oral hygiene limitations, emergency contact expectations, follow-up appointments. Generic guidance only. No medications named."},
    {"id":"hipaa_consent","title":"HIPAA Authorization","kind":"consent","required":true,"consent_key":"hipaa",
     "body":"Patient authorizes Practice to use and disclose protected health information as permitted by the Notice of Privacy Practices, a copy of which has been provided. This authorization may be revoked in writing at any time except to the extent Practice has already acted in reliance on it."},
    {"id":"treatment_risks_consent","title":"Informed Consent — Treatment Risks","kind":"consent","required":true,"consent_key":"treatment_risks",
     "body":"Patient acknowledges being informed of the risks of implant treatment, including but not limited to: infection, nerve injury, sinus involvement for upper-jaw implants, implant failure, bone loss, bruising, prolonged healing, and the possibility that additional procedures may be required. Patient has had the opportunity to ask questions. No specific outcome or success rate is guaranteed."},
    {"id":"photography_consent","title":"Photography & Records Consent","kind":"consent","required":false,"consent_key":"photography",
     "body":"Patient consents to dental photography, radiographic imaging, and 3D scanning for clinical records, case documentation, and — with separate written consent — educational or marketing purposes. Clinical use does not require additional consent."},
    {"id":"anesthesia_consent","title":"Anesthesia & Sedation Consent","kind":"consent","required":true,"consent_key":"anesthesia",
     "body":"Patient consents to the administration of local anesthesia and, if elected, oral sedation, IV sedation, or general anesthesia as clinically indicated. Patient acknowledges being informed of the risks including allergic reaction, drug interaction, and rare serious complications. Patient agrees to follow all pre-op fasting and transportation instructions."},
    {"id":"fees","title":"Fees & Financial Responsibility","kind":"data_table","required":true,
     "body":"Patient agrees to the total fees set forth below. This Agreement reflects estimated fees based on the treatment plan. Additional procedures not contemplated herein may incur additional charges.","data_source":"financial.summary"},
    {"id":"financing","title":"Payment & Financing Terms","kind":"ai_narrative","required":true,"max_ai_words":140,
     "ai_prompt":"Given the financing type ({{financial.financing_type}}), write 2-3 sentences describing the agreed payment arrangement. For ''loan'' or ''in_house'', reference that the monthly payment is set forth in the Fees section and note the lender handles the loan terms. For ''cash'', note payment is due at milestones. For ''insurance'', note Patient is responsible for the non-covered balance. Do NOT invent interest rates, terms, or lender names."},
    {"id":"deposit_refund","title":"Deposit & Refund Policy","kind":"boilerplate","required":true,
     "body":"A non-refundable deposit of {{financial.deposit_amount_formatted}} is due at signing. Patient may cancel this Agreement within {{legal.cancellation_policy_days}} days of signing for a full refund, less the non-refundable deposit. After that window, refund amounts are prorated against work performed and materials ordered, per {{legal.refund_policy_days}}-day refund policy."},
    {"id":"arbitration","title":"Dispute Resolution","kind":"boilerplate","required":true,
     "body":"Any dispute arising under this Agreement shall first be submitted to good-faith negotiation and, failing resolution, to binding arbitration administered in {{legal.arbitration_venue}} under the commercial rules of the American Arbitration Association. This Agreement is governed by {{legal.governing_law}}."},
    {"id":"liability","title":"Limitation of Liability","kind":"boilerplate","required":true,
     "body":"Practice makes no guarantee of any specific treatment outcome. Patient acknowledges that dentistry is not an exact science and that individual healing, bone quality, and anatomical variation can affect results. Practice''s liability under this Agreement is limited to the fees paid by Patient for the services at issue."},
    {"id":"esign_consent","title":"Electronic Signature Consent","kind":"consent","required":true,"consent_key":"esign",
     "body":"Under the federal ESIGN Act and applicable state UETA statutes, Patient consents to conduct this transaction by electronic means. Patient has the right to receive a paper copy of this Agreement upon request to the Practice. Patient represents having the hardware and software to access and retain this Agreement."},
    {"id":"signature","title":"Patient Signature","kind":"signature","required":true,
     "body":"By signing below electronically, Patient acknowledges having read and understood this Agreement in its entirety and agrees to all terms."}
  ]'::jsonb,
  array[
    'legal.entity_name','legal.state_of_formation','legal.principal_address_oneline',
    'legal.cancellation_policy_days','legal.refund_policy_days',
    'legal.arbitration_venue','legal.governing_law',
    'patient.full_name','today',
    'financial.financing_type','financial.deposit_amount_formatted'
  ],
  now()
from public.organizations o
where not exists (
  select 1 from public.contract_templates t
  where t.organization_id = o.id
    and t.slug = 'implant-services-agreement'
    and t.status = 'published'
);
