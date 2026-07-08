-- ═══════════════════════════════════════════════════════════════
-- Patient financing prequalification — per-lender soft-pull offers
-- ═══════════════════════════════════════════════════════════════
-- One row per (prequal run, lender). Records the collect-all result so the
-- coverage plan is reproducible and the staff/patient can revisit it.
-- decision=estimate means a link-only lender (indicative terms, no instant
-- decision). NOT a credit grade.
--
-- GATED: not auto-applied. A human applies via the project migration process
-- (supabase db query --linked -f <file>).
create table if not exists public.financing_prequal_offers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  run_id uuid not null,                          -- groups a single collect-all run
  requested_amount numeric not null,
  lender_slug text not null,
  lender_name text not null,
  decision text not null check (decision in ('approved','declined','estimate')),
  approved_amount numeric not null default 0,
  terms jsonb not null default '[]'::jsonb,      -- LenderTermOption[]
  created_at timestamptz not null default now()
);

create index if not exists idx_prequal_offers_lead on public.financing_prequal_offers (lead_id, run_id);
create index if not exists idx_prequal_offers_org on public.financing_prequal_offers (organization_id);

alter table public.financing_prequal_offers enable row level security;

drop policy if exists prequal_offers_org_isolation on public.financing_prequal_offers;
create policy prequal_offers_org_isolation on public.financing_prequal_offers
  for all
  using (organization_id = public.get_user_org_id())
  with check (organization_id = public.get_user_org_id());

comment on table public.financing_prequal_offers is 'Per-lender soft-pull prequalification results for a collect-all run. Not a credit grade; decision=estimate means link-only lender (indicative terms).';
