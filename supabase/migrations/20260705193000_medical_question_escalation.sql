-- Medical-question safety gate: extend escalations for clinical-question handling.
--
-- 1. Add a `priority` column so staff can triage. Clinical questions are stamped
--    high/urgent by the detector (src/lib/ai/medical-question-detector.ts).
-- 2. Add `medical_question_detected` to the allowed escalation reasons so the
--    autopilot gate can route "specific medical question → human" escalations.

-- ── priority column ──────────────────────────────────────────────────────────
ALTER TABLE escalations
  ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal'
  CHECK (priority IN ('low', 'normal', 'high', 'urgent'));

-- Surface urgent/high items first within a status bucket.
CREATE INDEX IF NOT EXISTS idx_escalations_org_status_priority
  ON escalations(organization_id, status, priority);

-- ── extend reason CHECK constraint ───────────────────────────────────────────
ALTER TABLE escalations DROP CONSTRAINT IF EXISTS escalations_reason_check;

ALTER TABLE escalations ADD CONSTRAINT escalations_reason_check CHECK (reason IN (
  'low_confidence',
  'patient_requested_human',
  'stop_word_detected',
  'compliance_flag',
  'max_attempts_reached',
  'agent_failure',
  'sentiment_drop',
  'medical_question_detected'
));
