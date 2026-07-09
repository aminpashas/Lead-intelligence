-- Adds a human-readable one-line recap of each lead's latest conversation,
-- written by the compact conversation sweep (src/lib/ai/conversation-sweep.ts)
-- alongside the existing enum signals (intent / sentiment / objection / red flag).
--
-- The enum columns are what Smart Lists segment on; this free-text column is for
-- staff/board display ("where does this patient stand, in one sentence"). It is
-- nullable and back-populated by the sweep + the one-time backfill cron, so no
-- default and no rewrite of existing rows is required.

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS conversation_summary text;
