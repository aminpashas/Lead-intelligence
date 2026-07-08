-- In-Closing book — the curated "Case Follow ups" deals the practice is actively
-- working to close.
--
-- WHY A TABLE (not a stage query): the /closing board used to derive its rows
-- from leads whose stage_id was treatment-presented | financing. Those stages
-- are polluted with thousands of stale GHL import labels (SF Dentistry has
-- ~2,678 leads parked there), so the board showed phantom deals — $0 value, 1%
-- close, never contacted. The closing book is a human-owned list; this table is
-- its source of truth. Seeded from the practice's spreadsheet.
--
-- Each row OPTIONALLY links to a CRM lead (lead_id) so Call/SMS/Email still work
-- when there's an unambiguous name match; the sheet itself carries no contact
-- info, so an unlinked row simply shows without action buttons.

create table if not exists public.closing_book (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Unambiguous CRM match, if any. NULL when 0 or >1 leads share the name.
  lead_id uuid references public.leads(id) on delete set null,
  first_name text not null default '',
  last_name  text not null default '',
  service    text,
  case_value numeric,
  -- Verbatim gut-feel cell from the sheet ("maybe", "Super cold", "CLOSED", a
  -- location note, …). Preserved so nothing the staff wrote is lost.
  status_raw text,
  -- Manual closing-temperature override. NULL = board derives it. Matches the
  -- leads.closing_temperature vocabulary so the UI is identical.
  temperature text check (temperature in ('hot','warm','cold','stalled')),
  -- 0..1, seeded from the sheet's gut feel; drives the weighted forecast.
  close_probability numeric,
  won boolean not null default false,
  -- The sheet's "Strategy" column — what we're doing next.
  next_step text,
  -- The sheet's "Status"/free-text narrative + overflow notes.
  status_note text,
  last_contact_at date,
  sort_order int not null default 0,
  source text not null default 'case-follow-ups',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists closing_book_org_idx on public.closing_book (organization_id, sort_order);
create index if not exists closing_book_lead_idx on public.closing_book (lead_id);

alter table public.closing_book enable row level security;

-- RLS mirrors leads exactly: get_user_org_id() resolves an agency_admin's
-- entered (active) org, so "managing SF Dentistry" reads/writes its rows.
create policy "Users can view closing_book in their org" on public.closing_book
  for select using (organization_id = get_user_org_id());
create policy "Users can insert closing_book in their org" on public.closing_book
  for insert with check (organization_id = get_user_org_id());
create policy "Users can update closing_book in their org" on public.closing_book
  for update using (organization_id = get_user_org_id());
create policy "Users can delete closing_book in their org" on public.closing_book
  for delete using (organization_id = get_user_org_id());
