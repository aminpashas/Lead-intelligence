-- ═══════════════════════════════════════════════════════════════
-- Browser softphone: conference-based bridge (enables hold + music)
-- ═══════════════════════════════════════════════════════════════
--
-- The outbound browser call now bridges the agent and the lead through a Twilio
-- Conference (friendly name `room_<voice_calls.id>`) instead of a peer <Dial>.
-- That's what lets us put the lead on hold with music mid-call (a peer <Dial>
-- tears the bridge down the moment a leg is pulled aside).
--
-- To hold the lead we address their conference participant by its Call SID, so we
-- persist that SID here when the lead leg is originated in /api/voice/twiml/outbound.
-- (twilio_call_sid remains the AGENT/browser leg, as before.)

ALTER TABLE voice_calls
  ADD COLUMN IF NOT EXISTS twilio_lead_call_sid text;

COMMENT ON COLUMN voice_calls.twilio_lead_call_sid IS
  'Twilio Call SID of the lead leg dialed into the conference bridge; used to hold/resume the lead participant. twilio_call_sid is the agent/browser leg.';
