-- Staff dialer on/off switch — independent of the AI voice layer.
--
-- `voice_enabled` gates the Retell AI dialer (and the shared preCallCheck). The
-- staff browser/bridge softphone now has its own switch so a practice can run
-- staff calls and AI calls independently (enable one, both, or neither).

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS dialer_enabled boolean NOT NULL DEFAULT false;

-- Preserve current behavior: any org that already had voice on (and therefore a
-- live staff dialer after the Phase-1 ship) keeps the dialer on.
UPDATE organizations SET dialer_enabled = true WHERE voice_enabled = true;

-- Policy: all staff calls are recorded. Turn recording on for every dialer-enabled
-- org so the softphone records from the first call.
UPDATE organizations SET voice_recording_enabled = true WHERE dialer_enabled = true;

COMMENT ON COLUMN organizations.dialer_enabled IS
  'Staff browser/bridge softphone dialer on/off. Independent of voice_enabled (which gates the Retell AI dialer).';
