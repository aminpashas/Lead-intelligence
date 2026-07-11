-- Empirical close-probability calibration (Workstream B1).
--
-- The pipeline board's close % was a hand-tuned multiplicative heuristic
-- (src/lib/pipeline/close-probability.ts). This migration adds the storage for
-- an EMPIRICAL model: the weekly calibrate-scoring cron fits an L2 logistic
-- regression on historical outcomes (converted vs lost/disqualified/stale),
-- versions every fit here for auditability, and stamps each active lead's
-- probability onto leads.close_probability so read paths stay cheap.

-- ── Model version registry ──────────────────────────────────────────────────
-- One row per fit. organization_id NULL = the pooled global model (trained on
-- all orgs; the fallback for orgs without enough converted outcomes of their
-- own). Rejected fits are stored with is_active = false so the training history
-- is a full audit trail, not just the winners.

create table if not exists public.scoring_model_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  model_kind text not null default 'close_probability_lr',
  -- { intercept: number, features: { <feature_name>: <beta> } } — feature names
  -- must match src/lib/scoring/features.ts featureNames for the same
  -- feature_schema_version.
  coefficients jsonb not null,
  -- { n_total, n_converted, auc, brier, calibration_bins } — holdout metrics
  -- from the 80/20 split; auc drives the activation guard in the cron.
  training_stats jsonb not null,
  feature_schema_version int not null default 1,
  fitted_at timestamptz not null default now(),
  is_active boolean not null default false
);

comment on table public.scoring_model_versions is
  'Versioned close-probability calibration fits (weekly cron). NULL organization_id = pooled global model.';

-- Exactly one active model per scope (org or pooled) per model kind. The
-- zero-uuid coalesce lets the pooled scope participate in the uniqueness.
create unique index if not exists scoring_model_versions_one_active_idx
  on public.scoring_model_versions (
    coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    model_kind
  )
  where is_active;

create index if not exists scoring_model_versions_org_idx
  on public.scoring_model_versions (organization_id, model_kind, fitted_at desc);

alter table public.scoring_model_versions enable row level security;

-- Read-only for org members: their own org's fits plus the pooled model (whose
-- coefficients contain no org data — it is trained across orgs but stores only
-- aggregate betas/metrics). All writes go through the service-role cron, which
-- bypasses RLS; no insert/update/delete policies on purpose.
create policy "Users can view scoring models in their org" on public.scoring_model_versions
  for select using (organization_id is null or organization_id = get_user_org_id());

-- ── Stamped probabilities on leads ──────────────────────────────────────────
-- The cron writes each active lead's calibrated probability here; read paths
-- (pipeline board) prefer the stamp when fresh and fall back to the live
-- heuristic otherwise.

alter table public.leads
  add column if not exists close_probability numeric(4,3),
  add column if not exists close_probability_model_id uuid references public.scoring_model_versions(id) on delete set null,
  add column if not exists close_probability_at timestamptz;

comment on column public.leads.close_probability is
  'Calibrated close probability (0..1) stamped by the calibrate-scoring cron. NULL = never stamped; readers fall back to the live heuristic.';
comment on column public.leads.close_probability_model_id is
  'scoring_model_versions row that produced close_probability.';
comment on column public.leads.close_probability_at is
  'When close_probability was stamped; readers treat stamps older than ~8 days as stale.';

create index if not exists idx_leads_close_probability
  on public.leads (organization_id, close_probability desc)
  where close_probability is not null;
