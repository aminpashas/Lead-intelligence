-- ═══════════════════════════════════════════════════════════════
-- Phase 4 — Competitor intelligence
-- ═══════════════════════════════════════════════════════════════
-- The agents had no competitor awareness. These tables hold the per-org
-- competitor knowledge base and the mentions detected in lead conversations,
-- so the Closer can address a named competitor with our concrete differentiators
-- (compliantly — no fabricated claims).

CREATE TABLE IF NOT EXISTS public.competitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  typical_pricing_notes text,
  weaknesses text,
  our_differentiators text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

ALTER TABLE public.competitors ENABLE ROW LEVEL SECURITY;
CREATE POLICY "competitors_select" ON public.competitors FOR SELECT USING (organization_id = public.get_user_org_id());
CREATE POLICY "competitors_insert" ON public.competitors FOR INSERT WITH CHECK (organization_id = public.get_user_org_id());
CREATE POLICY "competitors_update" ON public.competitors FOR UPDATE USING (organization_id = public.get_user_org_id());
CREATE POLICY "competitors_delete" ON public.competitors FOR DELETE USING (organization_id = public.get_user_org_id());

CREATE TABLE IF NOT EXISTS public.lead_competitor_mentions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  competitor_id uuid REFERENCES public.competitors(id) ON DELETE SET NULL,
  matched_term text,
  quote text,
  detected_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_competitor_mentions_lead
  ON public.lead_competitor_mentions(lead_id, detected_at DESC);

ALTER TABLE public.lead_competitor_mentions ENABLE ROW LEVEL SECURITY;
-- Staff read in-org; detection writes as service role (RLS-exempt).
CREATE POLICY "lead_competitor_mentions_select" ON public.lead_competitor_mentions
  FOR SELECT USING (organization_id = public.get_user_org_id());

COMMENT ON TABLE public.competitors IS 'Per-org competitor knowledge base (aliases, pricing notes, weaknesses, our differentiators) — Phase 4.';
COMMENT ON TABLE public.lead_competitor_mentions IS 'Competitor mentions detected in a lead conversation. Feeds competitor-aware Closer rebuttals.';
