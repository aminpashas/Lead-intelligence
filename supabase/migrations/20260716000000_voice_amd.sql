-- ═══════════════════════════════════════════════════════════════
-- Answering Machine Detection (AMD) for browser / bridge calls
--
-- Retell already tells us when its AI leg hits a machine (disconnection_reason
-- = voicemail_reached | machine_detected), so voicemail was a real outcome on
-- the AI path only. Twilio-originated legs (staff softphone, conference bridge)
-- were dialed with no machineDetection parameter at all, so voicemail was
-- physically undetectable there and voice_calls.status='voicemail' was
-- unreachable code.
--
-- dialLeadIntoConference now asks Twilio for async AMD; the verdict arrives
-- out-of-band at /api/voice/amd and lands here.
--
-- Why store the RAW verdict rather than just a boolean: AMD is tunable
-- (MachineDetectionSpeechThreshold, SilenceTimeout, …) and the only way to
-- tell an over-eager threshold from a genuine machine is to compare verdict
-- distribution against real outcomes. A boolean throws that away.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE voice_calls
  -- Twilio AnsweredBy, verbatim: human | fax | unknown | machine_start |
  -- machine_end_beep | machine_end_silence | machine_end_other.
  -- NULL = AMD not requested (all Retell/AI calls) or verdict not yet in.
  -- Intentionally NOT constrained: this mirrors a vendor vocabulary we do not
  -- own, and a new Twilio value must not start rejecting webhooks in prod.
  -- isMachineAnsweredBy() in post-call-review.ts is the allow-list that matters.
  ADD COLUMN IF NOT EXISTS answered_by text,
  -- Twilio MachineDetectionDuration (ms to reach the verdict). Kept for tuning:
  -- durations bunched at the SilenceTimeout ceiling mean AMD is timing out into
  -- 'unknown' rather than actually deciding.
  ADD COLUMN IF NOT EXISTS answered_by_ms integer;

-- Powers the Call Center voicemail filter and per-org voicemail-rate reporting.
-- Partial: only a minority of calls carry a verdict, so this stays small.
CREATE INDEX IF NOT EXISTS idx_voice_calls_answered_by
  ON voice_calls (organization_id, answered_by)
  WHERE answered_by IS NOT NULL;

-- ── Voicemail follow-up SMS ──────────────────────────────────────
-- When a staff dial hits voicemail, optionally text the lead so the touch isn't
-- wasted on a message they may never play.
--
-- DEFAULT FALSE is deliberate and load-bearing. This ships to orgs already
-- dialing in production; defaulting true would begin texting real patients the
-- moment the migration applies, with no one having asked for it. Opt-in per org.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS voice_voicemail_followup_sms_enabled boolean NOT NULL DEFAULT false,
  -- {first_name} and {practice_name} are substituted at send time. Kept editable
  -- per org because tone is a brand decision, not an engineering one.
  ADD COLUMN IF NOT EXISTS voice_voicemail_followup_sms_body text
    DEFAULT 'Hi {first_name}, this is {practice_name} — we just tried calling and left you a voicemail. Feel free to reply here if that''s easier.';

COMMENT ON COLUMN organizations.voice_voicemail_followup_sms_enabled IS
  'Opt-in: text the lead when a staff dial reaches voicemail. Send still passes the standard opt-out/DND + quiet-hours gates in sendSMSToLead.';
