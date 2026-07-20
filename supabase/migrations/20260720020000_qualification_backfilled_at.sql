-- Marks that we've already tried to mine a lead's conversation for qualification
-- facts (dental_condition / financing_interest / credit_range / timeline).
--
-- Needed because a *successful* extraction that finds nothing is indistinguishable
-- from a never-attempted one: both leave dental_condition NULL. Without this the
-- backfill would re-select and re-pay for the same barren transcripts every run.
--
-- Deliberately separate from conversation_analyzed_at (intent/sentiment sweep) —
-- different cadence, different cost, and re-running one shouldn't reset the other.
alter table public.leads
  add column if not exists qualification_backfilled_at timestamptz;

comment on column public.leads.qualification_backfilled_at is
  'When cron/backfill-qualification last mined this lead''s transcript for clinical/financial facts. Set even when nothing was found, so barren threads are not retried.';

-- Partial index over exactly the backfill''s selection predicate: never-attempted
-- leads that still lack a condition. Stays small as the backlog drains.
create index if not exists idx_leads_qualification_backfill_pending
  on public.leads (organization_id, last_responded_at desc)
  where qualification_backfilled_at is null and dental_condition is null;
