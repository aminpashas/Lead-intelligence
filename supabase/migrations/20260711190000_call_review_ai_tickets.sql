-- ═══════════════════════════════════════════════════════════════
-- Post-call review + AI improvement tickets
--
-- 1. voice_calls gains review_status / review_flags so the Call Center list
--    can show at a glance whether the post-call AI review flagged anything.
-- 2. ai_improvement_tickets: engineering-facing findings (AI-detected and
--    deterministic system checks) with a recommendation + action plan,
--    deduped by fingerprint. Surfaced in the Agency admin panel.
-- 3. human_tasks.kind gains 'call_review' so flagged calls land in the
--    human work queue (guarded — human_tasks is branch-new).
-- ═══════════════════════════════════════════════════════════════

-- ── 1. voice_calls review columns ────────────────────────────────
ALTER TABLE voice_calls
  ADD COLUMN IF NOT EXISTS review_status text
    CHECK (review_status IN ('pending', 'clear', 'flagged', 'escalated')),
  ADD COLUMN IF NOT EXISTS review_flags jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_voice_calls_review_status
  ON voice_calls (organization_id, review_status)
  WHERE review_status IN ('flagged', 'escalated');

-- ── 2. ai_improvement_tickets ────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_improvement_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable: unattributed SIP calls can still raise system tickets.
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,

  source text NOT NULL CHECK (source IN ('post_call_review', 'system_check')),
  category text NOT NULL CHECK (category IN (
    'agent_logic', 'prompt', 'telephony', 'data_gap', 'integration', 'other'
  )),
  severity text NOT NULL DEFAULT 'warning' CHECK (severity IN ('critical', 'warning', 'info')),

  title text NOT NULL,
  summary text,
  recommendation text,
  -- Ordered list of concrete steps ("action plan") proposed by the reviewer.
  action_plan jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Pointers back to the triggering call(s): { call_id, retell_call_id, ... }
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Dedupe: repeats of the same finding collapse onto one live ticket.
  fingerprint text NOT NULL,
  occurrence_count integer NOT NULL DEFAULT 1,
  last_seen_at timestamptz NOT NULL DEFAULT now(),

  status text NOT NULL DEFAULT 'open' CHECK (status IN (
    'open', 'acknowledged', 'in_progress', 'resolved', 'dismissed'
  )),
  resolution_note text,
  resolved_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  resolved_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One LIVE ticket per fingerprint; resolved/dismissed tickets free the key so
-- a regression re-opens as a fresh ticket.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ai_tickets_live_fingerprint
  ON ai_improvement_tickets (fingerprint)
  WHERE status IN ('open', 'acknowledged', 'in_progress');

CREATE INDEX IF NOT EXISTS idx_ai_tickets_status_created
  ON ai_improvement_tickets (status, created_at DESC);

ALTER TABLE ai_improvement_tickets ENABLE ROW LEVEL SECURITY;

-- Agency admins read + triage; writes come from the service role (webhooks).
DROP POLICY IF EXISTS "ai_tickets_agency_select" ON ai_improvement_tickets;
CREATE POLICY "ai_tickets_agency_select" ON ai_improvement_tickets
  FOR SELECT USING (public.is_agency_admin());

DROP POLICY IF EXISTS "ai_tickets_agency_update" ON ai_improvement_tickets;
CREATE POLICY "ai_tickets_agency_update" ON ai_improvement_tickets
  FOR UPDATE USING (public.is_agency_admin());

-- ── 3. human_tasks.kind += 'call_review' (guarded) ───────────────
DO $$
BEGIN
  IF to_regclass('public.human_tasks') IS NOT NULL THEN
    ALTER TABLE human_tasks DROP CONSTRAINT IF EXISTS human_tasks_kind_check;
    ALTER TABLE human_tasks ADD CONSTRAINT human_tasks_kind_check CHECK (kind IN (
      'inbound_reply', 'first_touch', 'nurture_step', 'stage_automation',
      'recommendation', 'sla_breach_review', 'call_review'
    ));
  END IF;
END $$;
