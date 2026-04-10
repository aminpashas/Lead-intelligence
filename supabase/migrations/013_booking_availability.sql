-- Migration 013: Booking & Self-Service Scheduling
-- Stores per-organization booking availability settings
-- for the public booking page at /book/[orgId].

create table public.booking_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations(id) on delete cascade,

  is_enabled boolean default true,
  slot_duration_minutes integer default 60 check (slot_duration_minutes between 15 and 240),
  buffer_minutes integer default 15 check (buffer_minutes between 0 and 120),
  advance_days integer default 14 check (advance_days between 1 and 90),
  min_notice_hours integer default 24 check (min_notice_hours between 1 and 168),

  -- Weekly schedule: { "1": {"start":"09:00","end":"17:00"}, ... }
  -- Keys: 0=Sunday, 1=Monday ... 6=Saturday
  weekly_schedule jsonb default '{
    "1": {"start": "09:00", "end": "17:00"},
    "2": {"start": "09:00", "end": "17:00"},
    "3": {"start": "09:00", "end": "17:00"},
    "4": {"start": "09:00", "end": "17:00"},
    "5": {"start": "09:00", "end": "17:00"}
  }'::jsonb,

  blocked_dates text[] default '{}',
  timezone text default 'America/New_York',
  booking_message text default 'Your consultation has been booked! We look forward to seeing you.',
  location text default '',
  max_bookings_per_slot integer default 1,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- No RLS — public reads via service client, admin writes via auth client
alter table booking_settings enable row level security;
create policy "booking_settings_org_access" on booking_settings
  for all using (organization_id = public.get_user_org_id());

-- Allow public read for the booking page (service role bypasses RLS anyway)
create policy "booking_settings_public_read" on booking_settings
  for select using (true);

create trigger booking_settings_updated_at
  before update on booking_settings
  for each row execute function update_updated_at_column();
