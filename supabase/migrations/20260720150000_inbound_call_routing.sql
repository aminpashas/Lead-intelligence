-- ═══════════════════════════════════════════════════════════════
-- Inbound call routing — ring agents first, voicemail fallback,
-- AI takeover per-surface.
-- ---------------------------------------------------------------
-- Today every inbound call is answered instantly by the Retell AI
-- agent. This adds a per-org routing policy:
--
--   inbound_call_mode = 'ai'          → AI answers immediately (default,
--                                       exactly today's behavior)
--   inbound_call_mode = 'ring_agents' → ring the practice's live targets
--                                       (voice_transfer_targets, windowed by
--                                       voice_transfer_routes) first, then:
--     • no answer  → voicemail, or the AI if inbound_ai_on_no_answer
--     • after hours→ voicemail, or the AI if inbound_ai_after_hours
--
-- Everything is additive and defaulted so no org changes behavior
-- until it opts in.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS inbound_call_mode text NOT NULL DEFAULT 'ai'
    CHECK (inbound_call_mode IN ('ai', 'ring_agents')),
  -- In ring_agents mode: when nobody picks up within the ring window, does the
  -- AI take the call (true) or does it go to voicemail (false = manual process)?
  ADD COLUMN IF NOT EXISTS inbound_ai_on_no_answer boolean NOT NULL DEFAULT false,
  -- In ring_agents mode: outside every voice_transfer_routes window, does the AI
  -- answer (true) or does the caller go straight to voicemail (false)?
  ADD COLUMN IF NOT EXISTS inbound_ai_after_hours boolean NOT NULL DEFAULT false,
  -- How long the agents' phones/softphones ring before the fallback kicks in.
  ADD COLUMN IF NOT EXISTS inbound_ring_seconds integer NOT NULL DEFAULT 20
    CHECK (inbound_ring_seconds BETWEEN 5 AND 60),
  -- Optional custom voicemail greeting (spoken via <Say>). NULL = generic default.
  ADD COLUMN IF NOT EXISTS inbound_voicemail_greeting text;

-- A caller leaving US a voicemail is a distinct outcome from us leaving THEM one
-- ('voicemail_left', outbound). The inline CHECK on voice_calls.outcome was
-- auto-named voice_calls_outcome_check.
ALTER TABLE voice_calls DROP CONSTRAINT IF EXISTS voice_calls_outcome_check;
ALTER TABLE voice_calls ADD CONSTRAINT voice_calls_outcome_check CHECK (outcome IN (
  'appointment_booked', 'callback_requested', 'interested',
  'not_interested', 'wrong_number', 'do_not_call',
  'voicemail_left', 'voicemail_received', 'no_answer',
  'technical_failure', 'transferred', NULL
));
