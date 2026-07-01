-- ═══════════════════════════════════════════════════════════════
-- Post-Consult Flow: attendance review, structured outcome, feedback
-- Builds on 20260701_phone_first_protocol.sql. Internal features are
-- always on; patient feedback is opt-in per practice (default OFF).
-- ═══════════════════════════════════════════════════════════════

-- 1. appointments: attendance-review + structured outcome
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS outcome_review_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS outcome_prompt_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS consult_outcome text
    CHECK (consult_outcome IS NULL OR consult_outcome IN
      ('treatment_accepted','deposit_paid','considering','declined','referred_out','no_decision')),
  ADD COLUMN IF NOT EXISTS consult_outcome_reason text
    CHECK (consult_outcome_reason IS NULL OR consult_outcome_reason IN
      ('price','financing','timing','second_opinion','medical','spouse_partner','other')),
  ADD COLUMN IF NOT EXISTS quoted_value_cents integer
    CHECK (quoted_value_cents IS NULL OR quoted_value_cents >= 0),
  ADD COLUMN IF NOT EXISTS outcome_notes text,
  ADD COLUMN IF NOT EXISTS outcome_follow_up_at timestamptz,
  ADD COLUMN IF NOT EXISTS outcome_recorded_at timestamptz,
  ADD COLUMN IF NOT EXISTS outcome_recorded_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_appointments_outcome_review_pending
  ON appointments (organization_id, outcome_review_pending)
  WHERE outcome_review_pending = true;

CREATE INDEX IF NOT EXISTS idx_appointments_outcome_recorded
  ON appointments (organization_id, outcome_recorded_at)
  WHERE outcome_recorded_at IS NOT NULL;

-- 2. booking_settings: feedback config (opt-in)
ALTER TABLE booking_settings
  ADD COLUMN IF NOT EXISTS feedback_request_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS google_review_url text,
  ADD COLUMN IF NOT EXISTS feedback_promoter_threshold smallint NOT NULL DEFAULT 4
    CHECK (feedback_promoter_threshold BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS feedback_delay_hours integer NOT NULL DEFAULT 2
    CHECK (feedback_delay_hours BETWEEN 0 AND 168);

-- 3. patient_feedback table
CREATE TABLE IF NOT EXISTS patient_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,
  token text NOT NULL UNIQUE,
  channel text NOT NULL CHECK (channel IN ('sms','email')),
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','responded','opted_out','bounced')),
  rating smallint CHECK (rating BETWEEN 1 AND 5),
  comment text,
  sentiment text CHECK (sentiment IS NULL OR sentiment IN ('positive','neutral','negative')),
  routed_to_review boolean NOT NULL DEFAULT false,
  requested_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_patient_feedback_appointment
  ON patient_feedback (appointment_id) WHERE appointment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_patient_feedback_org_status
  ON patient_feedback (organization_id, status);

-- 4. RLS: org-scoped reads/writes (public submit uses the service client + token)
ALTER TABLE patient_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY patient_feedback_org_select ON patient_feedback
  FOR SELECT USING (organization_id = get_user_org_id());
CREATE POLICY patient_feedback_org_all ON patient_feedback
  FOR ALL USING (organization_id = get_user_org_id())
  WITH CHECK (organization_id = get_user_org_id());
