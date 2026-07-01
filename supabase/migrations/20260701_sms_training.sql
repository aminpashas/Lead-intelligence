-- ═══════════════════════════════════════════════════════════════
-- SMS Training Console
-- ═══════════════════════════════════════════════════════════════
-- agency_ai_rules: agency-WIDE durable rules authored over SMS. Unlike
-- ai_memories (org-scoped) these have NO organization_id — they are injected
-- into every practice's live setter/closer prompt via buildAgencyRulesBlock.
-- sms_training_sessions: per-trainer-phone state between stateless webhook hits.

CREATE TABLE IF NOT EXISTS public.agency_ai_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL,
  content      text NOT NULL,
  category     text NOT NULL DEFAULT 'general',
  priority     int  NOT NULL DEFAULT 100,   -- higher = injected earlier
  is_enabled   boolean NOT NULL DEFAULT true,
  source       text NOT NULL DEFAULT 'sms_training',
  created_by   text,                         -- trainer phone (E.164)
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.agency_ai_rules ENABLE ROW LEVEL SECURITY;

-- Only agency_admin can read/write via the anon/auth client. The service role
-- (used by the live agents in the webhook path) bypasses RLS entirely.
CREATE POLICY "Agency admins can manage agency ai rules"
  ON public.agency_ai_rules FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid() AND role = 'agency_admin'
    )
  );

CREATE TABLE IF NOT EXISTS public.sms_training_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_phone     text NOT NULL,                 -- E.164, plain (operator infra, not patient PHI)
  mode              text NOT NULL,                 -- 'roleplay' | 'dry_run'
  scenario_key      text,
  patient_persona   jsonb,
  reference_org_id  uuid,
  transcript        jsonb NOT NULL DEFAULT '[]',    -- [{role, content}]
  rules_saved       int NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'active', -- 'active' | 'ended'
  started_at        timestamptz NOT NULL DEFAULT now(),
  last_activity_at  timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz
);

-- At most one active session per trainer phone.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_session_per_phone
  ON public.sms_training_sessions (trainer_phone) WHERE status = 'active';

ALTER TABLE public.sms_training_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agency admins can manage sms training sessions"
  ON public.sms_training_sessions FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid() AND role = 'agency_admin'
    )
  );
