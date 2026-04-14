-- ═══════════════════════════════════════════════════════════════
-- Appointment Reminders & Confirmation System
-- ═══════════════════════════════════════════════════════════════
-- Multi-channel reminder tracking (SMS, Email, Voice Confirmation Call)
-- with full audit trail and confirmation status management.

-- ──────────────────────────────────────────────────────────────
-- 1. Extend the appointments table with new tracking fields
-- ──────────────────────────────────────────────────────────────

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS reminder_sent_72h boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS reminder_sent_2h boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS confirmation_call_made boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS confirmed_via text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS reschedule_requested boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS no_show_risk_score integer DEFAULT 0;

-- Add comment for documentation
COMMENT ON COLUMN appointments.confirmed_via IS 'How the lead confirmed: sms_reply, email_click, voice_call, manual';
COMMENT ON COLUMN appointments.no_show_risk_score IS 'AI-calculated risk score 0-100 based on engagement patterns';

-- ──────────────────────────────────────────────────────────────
-- 2. Create the appointment_reminders tracking table
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS appointment_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,

  -- Reminder classification
  channel text NOT NULL CHECK (channel IN ('sms', 'email', 'voice_confirmation')),
  reminder_type text NOT NULL CHECK (reminder_type IN ('72h', '24h', '2h', '1h', 'confirmation_call', 'manual')),

  -- Delivery status
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'delivered', 'failed', 'skipped')),

  -- Confirmation tracking
  confirmation_status text NOT NULL DEFAULT 'pending' CHECK (confirmation_status IN ('pending', 'confirmed', 'declined', 'rescheduled', 'no_response')),

  -- Timestamps
  scheduled_for timestamptz,
  sent_at timestamptz,
  response_at timestamptz,

  -- Response details
  response_text text,

  -- External references
  external_id text,  -- Twilio SID / Resend ID / Retell Call ID
  voice_call_id uuid REFERENCES voice_calls(id) ON DELETE SET NULL,

  -- Error tracking
  error_message text,

  -- Metadata
  metadata jsonb DEFAULT '{}'::jsonb,

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- ──────────────────────────────────────────────────────────────
-- 3. Indexes for efficient queries
-- ──────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_appointment_reminders_org
  ON appointment_reminders(organization_id);

CREATE INDEX IF NOT EXISTS idx_appointment_reminders_appointment
  ON appointment_reminders(appointment_id);

CREATE INDEX IF NOT EXISTS idx_appointment_reminders_lead
  ON appointment_reminders(lead_id);

CREATE INDEX IF NOT EXISTS idx_appointment_reminders_status
  ON appointment_reminders(status, reminder_type);

CREATE INDEX IF NOT EXISTS idx_appointment_reminders_pending
  ON appointment_reminders(status, scheduled_for)
  WHERE status = 'pending';

-- Composite index for the cron job query pattern
CREATE INDEX IF NOT EXISTS idx_appointments_reminder_due
  ON appointments(organization_id, status, scheduled_at)
  WHERE status IN ('scheduled', 'confirmed');

-- ──────────────────────────────────────────────────────────────
-- 4. RLS Policies
-- ──────────────────────────────────────────────────────────────

ALTER TABLE appointment_reminders ENABLE ROW LEVEL SECURITY;

-- Users can view reminders for their organization
CREATE POLICY "Users can view own org reminders"
  ON appointment_reminders FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_id FROM user_profiles
      WHERE id = auth.uid()
    )
  );

-- Service role can insert/update (used by cron jobs)
CREATE POLICY "Service role full access to reminders"
  ON appointment_reminders FOR ALL
  USING (true)
  WITH CHECK (true);

-- ──────────────────────────────────────────────────────────────
-- 5. Updated_at trigger
-- ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_appointment_reminders_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER appointment_reminders_updated_at
  BEFORE UPDATE ON appointment_reminders
  FOR EACH ROW
  EXECUTE FUNCTION update_appointment_reminders_updated_at();
