-- Deliberating deals: a closer-chosen follow-up date.
--
-- Context: a lead in Treatment Presented / Financing who says "let me think /
-- talk to my spouse / save up" is engaged-and-waiting, NOT lost and NOT gone
-- quiet. The existing `closing_temperature` gains a manual 'deliberating' value
-- (enforced in app code, the column is free-text today), and this column carries
-- the date the closer agreed to circle back.
--
-- Queue behaviour (see src/lib/pipeline/closing.ts closingQueueState):
--   * deliberating + follow_up_at in the future  -> "waiting"  (muted, hidden from the live queue)
--   * deliberating + follow_up_at at/past now     -> "due"      (surfaces for the nudge)
-- A null value means no timer set — the deal is treated as active as before.

alter table public.leads
  add column if not exists closing_follow_up_at timestamptz;

comment on column public.leads.closing_follow_up_at is
  'When a deliberating deal (closing_temperature = ''deliberating'') should resurface for follow-up. Null = no timer.';

-- Partial index: the only query that reads this column is "which deliberating
-- deals are due?", so index just the rows that have a timer set.
create index if not exists idx_leads_closing_follow_up_at
  on public.leads (organization_id, closing_follow_up_at)
  where closing_follow_up_at is not null;
