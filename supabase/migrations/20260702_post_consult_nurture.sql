-- Migration: Post-Consult Funding Nurture
--
-- Adds the two schema hooks the objection-aware funding nurture needs:
--   1. leads.consult_completed_at — stamped when a consultation appointment is
--      marked "completed", so we know when the attend-but-no-close window opened
--      (and can measure time-to-close / nurture attribution).
--   2. campaign_steps.metadata — lets a step declare which AI generator composes
--      it (e.g. {"ai_generator":"closer","nurture_goal":"co_signer"}). The
--      campaign executor reads this to route nurture steps through the objection-
--      aware closer agent instead of the thin default engagement generator.
--
-- The nurture campaign itself is seeded per-org from TypeScript
-- (src/lib/campaigns/post-consult-nurture.ts, idempotent via
-- campaigns.metadata->>'system_key'), so the step content stays a single source
-- of truth rather than being duplicated into SQL.

-- 1. When did the patient attend their consult (and the close window open)?
alter table public.leads
  add column if not exists consult_completed_at timestamptz;

-- 2. Per-step generator/intent config for AI-personalized campaign steps.
alter table public.campaign_steps
  add column if not exists metadata jsonb default '{}';
