-- ═══════════════════════════════════════════════════════════════
-- AI Bulk Outbound → Live-Agent Transfer
-- ---------------------------------------------------------------
-- Adds the data model for an AI-fronted power dialer that connects
-- a live human on answer:
--   • org master toggle (voice_live_transfer_enabled) — OFF by default
--   • transfer targets (phone / sip / softphone reps)
--   • time-of-day routing rules (business hrs → hunt, off-hrs → concierge, overflow)
--   • rep presence (available / on_call) tracked server-side from call events
--   • voice_campaigns: mode (immediate/greet/qualify), dial ratio, hold cap
--   • voice_calls: transfer lifecycle tracking columns
--
-- Everything here is additive and defaulted so that an org that does
-- NOT turn this on behaves exactly as before.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. Org master switch ─────────────────────────────────────
-- Distinct from voice_enabled (which gates ALL voice). This gates the
-- specific "dial in bulk and forward answered calls to a live person"
-- capability, so it can be armed independently and audited on its own.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS voice_live_transfer_enabled boolean DEFAULT false,
  -- Cap on how long the AI will hold/qualify a live person while waiting
  -- for a rep to free up, before it gracefully wraps (books/voicemail/callback).
  -- Hard ceiling that protects against holding someone forever if staff are slammed.
  ADD COLUMN IF NOT EXISTS voice_live_transfer_max_hold_seconds integer DEFAULT 120;

-- ── 2. Transfer targets ──────────────────────────────────────
-- The "live people" an answered call can be forwarded to. A target is
-- either a PSTN number (front desk, a closer's cell, an answering service)
-- or an in-app softphone rep (a user_profiles row) for when PR #56 lands.
CREATE TABLE IF NOT EXISTS voice_transfer_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  name text NOT NULL,                       -- "Front desk", "Dr. Lee cell", "After-hours concierge"
  kind text NOT NULL DEFAULT 'phone' CHECK (kind IN ('phone', 'sip', 'softphone_user')),

  -- For kind='phone'/'sip': the destination to <Dial>. For 'softphone_user': null.
  destination text,
  -- For kind='softphone_user': which staff member's softphone identity to ring.
  user_id uuid REFERENCES user_profiles(id) ON DELETE CASCADE,

  -- Whether this target counts toward live-agent availability / can receive calls.
  active boolean NOT NULL DEFAULT true,
  -- Manual on/off-duty flag reps (or an admin) can flip without deactivating the target.
  on_duty boolean NOT NULL DEFAULT true,
  -- How many simultaneous transferred calls this target can hold (1 = a single human).
  max_concurrent integer NOT NULL DEFAULT 1,

  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),

  -- A phone/sip target must carry a destination; a softphone target must carry a user.
  CONSTRAINT voice_transfer_target_dest_ck CHECK (
    (kind IN ('phone','sip') AND destination IS NOT NULL)
    OR (kind = 'softphone_user' AND user_id IS NOT NULL)
  )
);

-- ── 3. Time-of-day routing rules ─────────────────────────────
-- Resolves "given the current time, who should an answered call go to,
-- in what order." The dispatcher/broker evaluates rules by priority and
-- picks the first whose day+hour window contains 'now' (in the rule tz).
-- One rule per row; target_ids is the ordered hunt list for that window.
CREATE TABLE IF NOT EXISTS voice_transfer_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  name text NOT NULL,                       -- "Business hours", "After hours", "Overflow"
  -- Lower number = evaluated first. Overflow rules typically get the highest number
  -- and is_overflow=true so they only apply when in-window targets are all busy.
  priority integer NOT NULL DEFAULT 100,

  -- Time window this rule covers. Mirrors voice_campaigns' active-hours shape.
  active_days text[] NOT NULL DEFAULT ARRAY['monday','tuesday','wednesday','thursday','friday'],
  start_hour integer NOT NULL DEFAULT 9,    -- inclusive, 0-23, local to `timezone`
  end_hour integer NOT NULL DEFAULT 18,     -- exclusive, 0-24
  timezone text NOT NULL DEFAULT 'America/New_York',

  -- Ordered list of voice_transfer_targets.id to try, first available wins.
  target_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],

  -- If true, this rule is a fallback used only when the primary in-window
  -- targets are all busy (e.g. spill to a concierge/answering service).
  is_overflow boolean NOT NULL DEFAULT false,

  active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- ── 4. Rep presence ──────────────────────────────────────────
-- Live availability per target. Kept as its own row (not a column on
-- targets) so the broker can atomically claim a free rep with an UPDATE
-- guarded on status, avoiding two answered leads racing onto one human.
CREATE TABLE IF NOT EXISTS voice_agent_presence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  target_id uuid NOT NULL REFERENCES voice_transfer_targets(id) ON DELETE CASCADE,

  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'on_call', 'offline')),
  -- How many calls are currently bridged to this target (vs max_concurrent).
  active_calls integer NOT NULL DEFAULT 0,
  -- The voice_calls row currently holding this rep (for single-seat targets).
  current_call_id uuid REFERENCES voice_calls(id) ON DELETE SET NULL,

  -- Heartbeat for softphone reps; also lets us reap stale 'on_call' locks if a
  -- release event is ever missed (a safety valve so a dropped webhook can't
  -- wedge a rep as permanently busy).
  last_heartbeat_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),

  UNIQUE(target_id)
);

-- ── 5. Campaign extensions ───────────────────────────────────
ALTER TABLE voice_campaigns
  -- Is this campaign a live-transfer campaign (vs. a pure AI campaign)?
  ADD COLUMN IF NOT EXISTS live_transfer_enabled boolean DEFAULT false,
  -- How much the AI says before it tries to hand off:
  --   immediate       → one connecting line, transfer ASAP
  --   greet_transfer  → brief warm greeting, then transfer
  --   qualify_transfer→ full discovery, transfer only if interested
  ADD COLUMN IF NOT EXISTS transfer_mode text DEFAULT 'immediate'
    CHECK (transfer_mode IN ('immediate', 'greet_transfer', 'qualify_transfer')),
  -- Burst multiplier: dial (ratio × available_reps) leads at a time. 1.0 = progressive
  -- (safest). >1 dials ahead; the AI-holds-the-line design keeps that from abandoning.
  ADD COLUMN IF NOT EXISTS dial_ratio numeric(3,1) DEFAULT 1.0,
  -- Per-campaign override of the org hold cap; NULL = inherit org default.
  ADD COLUMN IF NOT EXISTS max_hold_seconds integer;

-- ── 6. voice_calls transfer tracking ─────────────────────────
ALTER TABLE voice_calls
  ADD COLUMN IF NOT EXISTS transfer_status text DEFAULT 'none'
    CHECK (transfer_status IN ('none', 'requested', 'holding', 'bridged', 'completed', 'abandoned', 'failed')),
  ADD COLUMN IF NOT EXISTS transferred_to_target_id uuid REFERENCES voice_transfer_targets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS transfer_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS transfer_bridged_at timestamptz,
  -- Seconds the AI held/qualified the live person before a rep picked up (or gave up).
  -- The compliance-critical metric: this is what proves we never left dead air.
  ADD COLUMN IF NOT EXISTS hold_seconds integer DEFAULT 0;

-- ── 7. Indexes ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_voice_transfer_targets_org ON voice_transfer_targets(organization_id) WHERE active;
CREATE INDEX IF NOT EXISTS idx_voice_transfer_routes_org ON voice_transfer_routes(organization_id) WHERE active;
CREATE INDEX IF NOT EXISTS idx_voice_agent_presence_org ON voice_agent_presence(organization_id);
CREATE INDEX IF NOT EXISTS idx_voice_agent_presence_available
  ON voice_agent_presence(organization_id, status) WHERE status = 'available';
CREATE INDEX IF NOT EXISTS idx_voice_calls_transfer_status
  ON voice_calls(transfer_status) WHERE transfer_status IN ('requested', 'holding');

-- ── 8. RLS ───────────────────────────────────────────────────
ALTER TABLE voice_transfer_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_transfer_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_agent_presence ENABLE ROW LEVEL SECURITY;

CREATE POLICY "voice_transfer_targets_org_isolation" ON voice_transfer_targets
  FOR ALL USING (
    organization_id IN (SELECT organization_id FROM user_profiles WHERE id = auth.uid())
  );
CREATE POLICY "voice_transfer_routes_org_isolation" ON voice_transfer_routes
  FOR ALL USING (
    organization_id IN (SELECT organization_id FROM user_profiles WHERE id = auth.uid())
  );
CREATE POLICY "voice_agent_presence_org_isolation" ON voice_agent_presence
  FOR ALL USING (
    organization_id IN (SELECT organization_id FROM user_profiles WHERE id = auth.uid())
  );

-- Service role bypass for the broker endpoint + dispatcher cron.
CREATE POLICY "voice_transfer_targets_service_role" ON voice_transfer_targets
  FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "voice_transfer_routes_service_role" ON voice_transfer_routes
  FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "voice_agent_presence_service_role" ON voice_agent_presence
  FOR ALL USING (auth.role() = 'service_role');

-- ── 9. updated_at triggers (reuse update_voice_updated_at) ───
CREATE TRIGGER voice_transfer_targets_updated_at
  BEFORE UPDATE ON voice_transfer_targets
  FOR EACH ROW EXECUTE FUNCTION update_voice_updated_at();
CREATE TRIGGER voice_transfer_routes_updated_at
  BEFORE UPDATE ON voice_transfer_routes
  FOR EACH ROW EXECUTE FUNCTION update_voice_updated_at();
CREATE TRIGGER voice_agent_presence_updated_at
  BEFORE UPDATE ON voice_agent_presence
  FOR EACH ROW EXECUTE FUNCTION update_voice_updated_at();

-- ── 10. Atomic rep-claim helper ──────────────────────────────
-- Claims the first available target from an ordered candidate list, flipping it
-- to on_call in the same statement so two concurrent answered calls can never
-- grab the same single-seat rep. Returns the claimed target_id, or NULL if none free.
CREATE OR REPLACE FUNCTION claim_available_transfer_target(
  p_org_id uuid,
  p_candidate_ids uuid[],
  p_call_id uuid
)
RETURNS uuid AS $$
DECLARE
  v_target_id uuid;
BEGIN
  -- Lock the first free candidate (respecting the caller's priority order) and seat the call.
  SELECT p.target_id INTO v_target_id
  FROM voice_agent_presence p
  JOIN voice_transfer_targets t ON t.id = p.target_id
  WHERE p.organization_id = p_org_id
    AND p.target_id = ANY(p_candidate_ids)
    AND t.active AND t.on_duty
    AND p.status = 'available'
    AND p.active_calls < t.max_concurrent
  ORDER BY array_position(p_candidate_ids, p.target_id)
  FOR UPDATE OF p SKIP LOCKED
  LIMIT 1;

  IF v_target_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE voice_agent_presence
  SET status = CASE WHEN active_calls + 1 >= (
        SELECT max_concurrent FROM voice_transfer_targets WHERE id = v_target_id
      ) THEN 'on_call' ELSE 'available' END,
      active_calls = active_calls + 1,
      current_call_id = p_call_id,
      updated_at = now()
  WHERE target_id = v_target_id;

  RETURN v_target_id;
END;
$$ LANGUAGE plpgsql;

-- Releases a rep when a transferred call ends (or the hold is abandoned).
CREATE OR REPLACE FUNCTION release_transfer_target(p_target_id uuid)
RETURNS void AS $$
BEGIN
  UPDATE voice_agent_presence
  SET active_calls = GREATEST(active_calls - 1, 0),
      status = CASE WHEN GREATEST(active_calls - 1, 0) = 0 THEN 'available' ELSE status END,
      current_call_id = NULL,
      updated_at = now()
  WHERE target_id = p_target_id;
END;
$$ LANGUAGE plpgsql;
