-- Allow the tier-1 morning-of check-in ('checkin_4h') in the reminder audit trail.
-- The original CHECK (20260414_appointment_reminders.sql) only allowed
-- 72h/24h/2h/1h/confirmation_call/manual.
ALTER TABLE appointment_reminders
  DROP CONSTRAINT IF EXISTS appointment_reminders_reminder_type_check;

ALTER TABLE appointment_reminders
  ADD CONSTRAINT appointment_reminders_reminder_type_check
  CHECK (reminder_type IN ('72h', '24h', '2h', '1h', 'confirmation_call', 'checkin_4h', 'manual'));
