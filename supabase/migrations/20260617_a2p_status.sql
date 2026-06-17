-- ═══════════════════════════════════════════════════════════════
-- Phase 1.3 — A2P 10DLC status snapshot (for the status-monitor cron)
-- ═══════════════════════════════════════════════════════════════
-- The a2p-status cron polls Twilio's compliance API for brand + campaign status
-- and stores the latest snapshot here so it can (a) detect transitions and alert,
-- and (b) give the UI/ops a queryable "is US SMS unblocked yet" answer without a
-- live Twilio call. One row per campaign SID.

CREATE TABLE IF NOT EXISTS public.a2p_status (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_sid text NOT NULL UNIQUE,
  campaign_status text,
  previous_campaign_status text,
  brand_sid text,
  brand_status text,
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  last_transition_at timestamptz,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.a2p_status IS 'Latest Twilio A2P 10DLC brand+campaign status snapshot, one row per campaign SID. Written by the a2p-status cron (service role). campaign_status VERIFIED = US SMS can be enabled.';

-- Global ops/infra data (not org-scoped). Service role writes; authenticated staff
-- may read so the dashboard can show deliverability status.
ALTER TABLE public.a2p_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read a2p status"
  ON public.a2p_status FOR SELECT
  TO authenticated
  USING (true);
