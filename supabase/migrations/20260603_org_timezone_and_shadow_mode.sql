-- Org timezone (TCPA quiet-hours correctness) + shadow / outreach-suppressed mode
--
-- FIX 1: Quiet hours were computed in UTC. Add a per-org timezone so the
--        autopilot can evaluate active-hours / day-of-week in the patient's
--        local time. Dion Health is US Eastern.
--
-- FIX 3: Shadow mode. Lets Lead Intelligence run beside GoHighLevel during
--        cutover: agents still score/draft, but no outbound message is sent
--        (humans see the drafts via escalations). Prevents double-texting.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/New_York';

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS autopilot_outreach_suppressed BOOLEAN NOT NULL DEFAULT FALSE;
