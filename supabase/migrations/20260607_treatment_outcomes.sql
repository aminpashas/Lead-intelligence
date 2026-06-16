-- Post-treatment outcome tracking.
--
-- Closes the optimization loop: lets the closer/technique grading and the ad-platform
-- conversion signal optimize to REAL clinical + revenue outcomes (success vs
-- complication / revision / failure), not just "reached the completed stage".
--
-- Deliberately a SEPARATE table — NOT new values on the leads.status CHECK constraint
-- (002_leads_and_pipeline.sql) — to avoid destabilizing the lifecycle enum that the
-- pipeline Kanban and the DGS writeback trigger depend on. Leads still move to
-- 'completed'/'lost'; the post-surgery clinical result lives here and can have history
-- (e.g. an initial 'success' later followed by a 'revision').

create table if not exists public.treatment_outcomes (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations(id) on delete cascade,
  lead_id              uuid not null references public.leads(id) on delete cascade,
  treatment_closing_id uuid references public.treatment_closings(id) on delete set null,
  clinical_case_id     uuid references public.clinical_cases(id) on delete set null,
  outcome              text not null check (outcome in ('success', 'complication', 'revision', 'failure')),
  satisfaction_score   int check (satisfaction_score between 1 and 10),
  follow_up_attended   boolean,
  revision_required    boolean not null default false,
  final_revenue        numeric,
  notes                text,
  recorded_by          uuid,
  occurred_at          timestamptz not null default now(),
  created_at           timestamptz not null default now()
);

create index if not exists idx_treatment_outcomes_lead
  on public.treatment_outcomes (lead_id);
create index if not exists idx_treatment_outcomes_org_occurred
  on public.treatment_outcomes (organization_id, occurred_at desc);

alter table public.treatment_outcomes enable row level security;

-- Mirror the clinical_cases posture: org members (resolved via user_profiles) can read
-- and manage their own org's outcomes. The service role bypasses RLS for server routes
-- and crons. Explicit WITH CHECK on the manage policy per the 20260604 RLS hardening.
create policy "Org members can view treatment outcomes"
  on public.treatment_outcomes for select
  using (
    organization_id in (select organization_id from public.user_profiles where id = auth.uid())
  );

create policy "Clinical staff can manage treatment outcomes"
  on public.treatment_outcomes for all
  using (
    organization_id in (select organization_id from public.user_profiles where id = auth.uid())
  )
  with check (
    organization_id in (select organization_id from public.user_profiles where id = auth.uid())
  );
