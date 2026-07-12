-- Pre-qualification lifecycle tracking
--
-- Adds the timestamps + counters the pre-qual flow needs to answer three
-- questions the staff CRM (and the reminder cron) ask of every financing link:
--   1. When was it first sent, and when was it last touched?  (first_sent_at / last_sent_at)
--   2. How many reminders has the patient already gotten?     (reminder_count / last_reminder_at)
--   3. Has the patient actually filled it out yet?            (submitted_at)
--
-- `financing_applications.completed_at` already exists but overloads "closed"
-- (it's stamped on EXPIRY too), so it can't stand in for "patient submitted".
-- `submitted_at` is the unambiguous "they filled it out" moment and is what the
-- reminder cron filters on — a submitted app is never nudged again, even during
-- the brief window before the lender waterfall flips `status` off `pending`.

ALTER TABLE financing_applications
  ADD COLUMN IF NOT EXISTS first_sent_at    timestamptz,
  ADD COLUMN IF NOT EXISTS last_sent_at     timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_count   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reminder_at timestamptz,
  ADD COLUMN IF NOT EXISTS submitted_at     timestamptz;

-- The reminder cron scans for pending, sent-but-not-submitted, unexpired links.
-- A partial index keeps that daily sweep cheap as the table grows.
CREATE INDEX IF NOT EXISTS idx_financing_apps_prequal_reminders
  ON financing_applications (first_sent_at, reminder_count)
  WHERE status = 'pending' AND submitted_at IS NULL AND first_sent_at IS NOT NULL;

COMMENT ON COLUMN financing_applications.first_sent_at IS
  'First time a pre-qual/financing link was sent to the patient. Never overwritten — see last_sent_at for the most recent touch.';
COMMENT ON COLUMN financing_applications.submitted_at IS
  'When the patient (or a co-signer on their behalf) actually completed the financing form. Distinct from completed_at, which also covers expiry.';
COMMENT ON COLUMN financing_applications.reminder_count IS
  'Number of automated reminder nudges sent for this pending link (cap enforced by the prequal-reminders cron).';
