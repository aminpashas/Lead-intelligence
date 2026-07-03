-- Practice profile: structured answers from the campaign-onboarding interview.
-- One row per org. `core` holds the shared sections (hours, operations,
-- appointments, consult_flow, technology, pricing, preferences); `addons` holds
-- per-service-line answers keyed by blueprint slug ('implants', 'veneers',
-- 'tmj', 'sleep_apnea'). Rows are written only via schema-validated partial
-- merges in the API layer (src/lib/validators/practice-profile.ts) — sections
-- deep-merge so an interview answer never clobbers a sibling answer.
create table if not exists public.practice_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations(id) on delete cascade,
  core jsonb not null default '{}'::jsonb,
  addons jsonb not null default '{}'::jsonb,
  -- Agency-controlled: when false, non-admin practice staff cannot run the
  -- onboarding interview themselves (admins and agency admins always can).
  -- Enforced in the API layer; RLS stays org-scoped.
  self_serve_enabled boolean not null default false,
  last_interview_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.practice_profiles enable row level security;

create policy "Users can view practice profile in their org"
  on public.practice_profiles for select
  using (organization_id = public.get_user_org_id());

create policy "Users can manage practice profile in their org"
  on public.practice_profiles for all
  using (organization_id = public.get_user_org_id());

create trigger set_practice_profiles_updated_at
  before update on public.practice_profiles
  for each row execute function public.handle_updated_at();

-- Service line a blueprint-launched campaign belongs to
-- ('implants' | 'veneers' | 'tmj' | 'sleep_apnea'); null for legacy campaigns.
alter table public.campaigns add column if not exists service_line text;

create index if not exists idx_campaigns_service_line
  on public.campaigns (organization_id, service_line);
