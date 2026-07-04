-- In-Closing workflow: editable per-deal fields for the /closing board.
--
-- The board reads real pipeline data (leads in the treatment-presented + financing
-- stages) — case value, last contact, close probability are all already tracked.
-- What the old "Case Follow ups" spreadsheet captured that the CRM did not is two
-- pieces of human judgment per deal:
--   * a closing temperature (the sheet's "maybe / cold / super cold" column), and
--   * the next-step / strategy note ("offered 3rd party financing", "DP pending").
--
-- Temperature has a derived default (see src/lib/pipeline/closing.ts), so this
-- column stores only a MANUAL OVERRIDE — null means "use the derived value".

alter table public.leads
  add column if not exists closing_temperature text
    check (closing_temperature in ('hot', 'warm', 'cold', 'stalled')),
  add column if not exists closing_next_step text,
  add column if not exists closing_updated_at timestamptz;

comment on column public.leads.closing_temperature is
  'Manual override of the derived closing temperature on the /closing board. Null = use deriveClosingTemperature().';
comment on column public.leads.closing_next_step is
  'Free-text next action for a deal in closing (the spreadsheet''s Strategy column).';
comment on column public.leads.closing_updated_at is
  'When a human last touched the closing temperature / next step.';
