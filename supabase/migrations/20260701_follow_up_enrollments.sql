-- Multi-step follow-up sequence enrollments.
-- One active enrollment per lead; the cron /api/cron/follow-up-sequences fires
-- due steps (allowlist- + consent-gated). RLS scopes to the caller's org.

create table if not exists public.follow_up_enrollments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'completed', 'stopped')),
  current_step integer not null default 0,
  enrolled_at timestamptz not null default now(),
  last_step_sent_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (lead_id)
);

create index if not exists idx_follow_up_enrollments_active
  on public.follow_up_enrollments (enrolled_at)
  where status = 'active';

alter table public.follow_up_enrollments enable row level security;

create policy "Org members can view follow-up enrollments"
  on public.follow_up_enrollments for select
  using (organization_id = public.get_user_org_id());

create policy "Org members can manage follow-up enrollments"
  on public.follow_up_enrollments for all
  using (organization_id = public.get_user_org_id())
  with check (organization_id = public.get_user_org_id());
