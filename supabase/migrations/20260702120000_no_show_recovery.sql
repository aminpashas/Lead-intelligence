-- Migration: No-Show Recovery nurture — campaign_steps.metadata
--
-- The no-show recovery sequence (src/lib/campaigns/no-show-recovery.ts) is
-- seeded per-org from TypeScript (idempotent via campaigns.metadata->>'system_key'),
-- so there is no campaign SQL here. It does, however, write per-step
-- metadata (e.g. {"ai_generator":"closer","nurture_goal":"..."}) so AI-composed
-- steps can be routed to the objection-aware closer agent.
--
-- campaign_steps.metadata is also added by 20260702_post_consult_nurture.sql on
-- feat/online-booking-ehr; both use IF NOT EXISTS so apply order doesn't matter.

alter table public.campaign_steps
  add column if not exists metadata jsonb default '{}';
