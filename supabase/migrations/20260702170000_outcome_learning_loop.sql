-- ═══════════════════════════════════════════════════════════════
-- Outcome-Driven Learning Loop
-- ═══════════════════════════════════════════════════════════════
-- learning_episodes: one row per (lead, outcome event) — the full communication
--   journey that led to a real outcome (booked / showed / no_show /
--   contract_signed / lost), assembled nightly. This is the labeled training
--   corpus the weekly distillation pass contrasts (won vs lost cohorts).
-- learning_runs: audit log of distillation passes (what was computed, which
--   candidate rules were written, which live rules got flagged).
-- agency_ai_rules gains a review lifecycle so auto-learned candidate rules are
--   NEVER live without human approval: rows with source='auto_learning' start
--   is_enabled=false + review_status='pending' and only an agency admin flips
--   them on. buildAgencyRulesBlock already filters is_enabled=true, so pending
--   candidates are invisible to live agents with no code change there.

CREATE TABLE IF NOT EXISTS public.learning_episodes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lead_id          uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  outcome          text NOT NULL CHECK (outcome IN ('booked','showed','no_show','contract_signed','lost')),
  outcome_at       timestamptz NOT NULL,
  -- id of the row that produced the label (appointment id / lead_activity id),
  -- part of the natural key so re-runs upsert instead of duplicating
  outcome_ref      text NOT NULL DEFAULT '',
  -- [{at, role, channel, sender, body(truncated+scrubbed), technique_ids[], rule_set_version}]
  journey          jsonb NOT NULL DEFAULT '[]',
  -- code-computed features: message counts, response latencies, ai share,
  -- techniques used, engagement trajectory, days_span, rule_set_versions[]
  journey_stats    jsonb NOT NULL DEFAULT '{}',
  message_count    int  NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lead_id, outcome, outcome_ref)
);

CREATE INDEX IF NOT EXISTS idx_learning_episodes_org       ON public.learning_episodes(organization_id);
CREATE INDEX IF NOT EXISTS idx_learning_episodes_outcome   ON public.learning_episodes(outcome, outcome_at DESC);

ALTER TABLE public.learning_episodes ENABLE ROW LEVEL SECURITY;

-- Practices can read their own episodes; agency admins read all.
-- Writes happen only via the service role (cron), which bypasses RLS.
CREATE POLICY "Org members can view own learning episodes"
  ON public.learning_episodes FOR SELECT
  USING (
    organization_id = public.get_user_org_id()
    OR EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid() AND role = 'agency_admin'
    )
  );

CREATE TABLE IF NOT EXISTS public.learning_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               text NOT NULL DEFAULT 'distill',   -- 'distill'
  episode_count      int  NOT NULL DEFAULT 0,
  technique_rows     int  NOT NULL DEFAULT 0,
  findings           jsonb NOT NULL DEFAULT '[]',       -- code-computed contrasts (incl. skipped/code_fixable)
  candidates_created int  NOT NULL DEFAULT 0,
  rules_flagged      int  NOT NULL DEFAULT 0,           -- retire_flagged this run
  error              text,
  duration_ms        int,
  created_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.learning_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agency admins can view learning runs"
  ON public.learning_runs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid() AND role = 'agency_admin'
    )
  );

-- ── agency_ai_rules: review lifecycle for auto-learned rules ────
-- review_status is NULL for human-authored rules (sms_training) — they are
-- implicitly approved. Auto-learned rules move pending → approved/rejected,
-- and approved ones can later become retire_flagged → retired by the
-- performance pass.
ALTER TABLE public.agency_ai_rules
  ADD COLUMN IF NOT EXISTS review_status     text CHECK (review_status IN ('pending','approved','rejected','retire_flagged','retired')),
  ADD COLUMN IF NOT EXISTS evidence          jsonb,        -- {finding_key, headline, detail, stats, examples[]}
  ADD COLUMN IF NOT EXISTS approved_by       text,
  ADD COLUMN IF NOT EXISTS approved_at       timestamptz,
  ADD COLUMN IF NOT EXISTS enabled_at        timestamptz,  -- when the rule went live (cohort boundary for before/after)
  ADD COLUMN IF NOT EXISTS retired_at        timestamptz,
  ADD COLUMN IF NOT EXISTS retirement_reason text,
  ADD COLUMN IF NOT EXISTS performance       jsonb;        -- {before:{n,rate}, after:{n,rate}, z, computed_at}

CREATE INDEX IF NOT EXISTS idx_agency_ai_rules_source ON public.agency_ai_rules(source);
