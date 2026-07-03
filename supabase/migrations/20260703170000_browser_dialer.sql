-- Browser softphone dialer (Phase 1)
--
-- Staff can now place live outbound calls from the browser via the Twilio Voice
-- WebRTC SDK — distinct from the existing Retell AI calls. Three new columns on
-- voice_calls support this:
--
--   staff_user_id  — which human placed the call (NULL for AI/inbound)
--   call_mode      — 'ai' (Retell), 'browser' (softphone), 'bridge' (ring-my-phone)
--   dial_token     — one-time secret the browser hands to Twilio's TwiML fetch so
--                    the public /api/voice/twiml/outbound route can authorize the
--                    dial WITHOUT a user session. Minted by the authenticated
--                    /api/voice/prepare route (which runs the full compliance
--                    gate), consumed once when Twilio fetches the TwiML, and never
--                    reused. Closes the cross-org hole that passing lead_id/org_id
--                    as raw dial params would open.

ALTER TABLE voice_calls
  ADD COLUMN IF NOT EXISTS staff_user_id uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS call_mode text CHECK (call_mode IN ('ai', 'browser', 'bridge')),
  ADD COLUMN IF NOT EXISTS dial_token text;

-- The TwiML route looks a call up by its unconsumed dial_token; keep that lookup
-- fast and scoped to the brief window a token is live.
CREATE INDEX IF NOT EXISTS idx_voice_calls_dial_token
  ON voice_calls(dial_token)
  WHERE dial_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_voice_calls_staff_user
  ON voice_calls(staff_user_id)
  WHERE staff_user_id IS NOT NULL;

COMMENT ON COLUMN voice_calls.dial_token IS
  'One-time token issued by /api/voice/prepare, consumed by /api/voice/twiml/outbound to authorize a browser-placed dial. Never reused.';
