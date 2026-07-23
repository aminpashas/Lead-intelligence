-- Admin-facing duplicate consolidation: reversible soft-merge + review tasks.
--
-- WHAT: two things the operational dedup loop needs and did not have.
--
--  1. `leads_dedup_archive` — a committed home for the pre-merge snapshot of a
--     losing lead, so every merge is undoable. This table was previously created
--     ad hoc by `scripts/dedup-whatconverts-leads.ts` (untracked); promoting it
--     to a migration means the merge API can rely on it existing in every env.
--
--  2. `human_tasks.kind += 'duplicate_review'` — the task the sweep mints, one
--     per detected cluster, so duplicates surface in the queue staff already work
--     rather than needing a separate screen.
--
-- WHY SOFT-MERGE (not delete): `consent_log` has an ON DELETE CASCADE FK to
-- leads and is append-only (a BEFORE DELETE trigger rejects the cascade), so a
-- hard DELETE of a lead carrying consent history is refused by the database.
-- The merge therefore never deletes the loser — it flips it to `disqualified`
-- with a `custom_fields.merged_into` pointer — which also keeps DGS's
-- `inbound_leads.intel_lead_id` (and the LI->DGS conversion writeback) valid.

-- ── Archive (reversible) ────────────────────────────────────────────────────
create table if not exists public.leads_dedup_archive (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- The lead that lost the merge (now disqualified, not deleted). Not an FK: the
  -- whole point is to survive even if that row is later hard-removed.
  loser_lead_id uuid not null,
  -- The surviving canonical lead the loser was merged into.
  winner_lead_id uuid not null,
  reason text not null default 'manual_merge',
  -- Full pre-merge snapshot of the loser row (encrypted PII included, verbatim),
  -- so an un-merge can restore it exactly as it was.
  lead jsonb not null,
  -- Child-row counts moved to the winner, for the audit trail / un-merge.
  moved jsonb not null default '{}'::jsonb,
  merged_by uuid references public.user_profiles(id) on delete set null,
  merged_at timestamptz not null default now(),
  -- Set when an un-merge restores the loser; a non-null value means "reversed".
  restored_at timestamptz,
  restored_by uuid references public.user_profiles(id) on delete set null
);

create index if not exists leads_dedup_archive_org_idx
  on public.leads_dedup_archive (organization_id, merged_at desc);
create index if not exists leads_dedup_archive_loser_idx
  on public.leads_dedup_archive (loser_lead_id);
create index if not exists leads_dedup_archive_winner_idx
  on public.leads_dedup_archive (winner_lead_id);

alter table public.leads_dedup_archive enable row level security;

-- Standard org-scoped RLS. get_user_org_id() resolves an agency_admin's entered
-- org, so managing a client org covers its archive rows too.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'leads_dedup_archive'
      and policyname = 'Users can view dedup archive in their org'
  ) then
    create policy "Users can view dedup archive in their org"
      on public.leads_dedup_archive for select
      using (organization_id = get_user_org_id());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'leads_dedup_archive'
      and policyname = 'Users can insert dedup archive in their org'
  ) then
    create policy "Users can insert dedup archive in their org"
      on public.leads_dedup_archive for insert
      with check (organization_id = get_user_org_id());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'leads_dedup_archive'
      and policyname = 'Users can update dedup archive in their org'
  ) then
    create policy "Users can update dedup archive in their org"
      on public.leads_dedup_archive for update
      using (organization_id = get_user_org_id());
  end if;
end $$;

-- ── Cluster discovery RPC (for the review-task sweep) ──────────────────────
-- Groups live leads (not already merged away) by exact contact hash and returns
-- every hash shared by >1 lead. Grouping ONLY — the confidence policy that
-- decides which clusters become tasks stays in one place in TypeScript
-- (`classifyConfidence`), which re-scores the returned rows.
--
-- SECURITY INVOKER + an explicit org guard: the function runs as the caller, so
-- RLS already confines it to the caller's org; the guard makes a cross-org
-- p_org_id return nothing rather than relying on RLS alone (see the p_org_id
-- side-door hardening — every such function is guarded).
create or replace function public.find_duplicate_clusters(
  p_org_id uuid,
  p_limit int default 200
)
returns table (key_type text, key_hash text, lead_ids uuid[])
language sql
stable
security invoker
set search_path = public
as $$
  with active as (
    select id, email_hash, phone_hash
    from public.leads
    where organization_id = p_org_id
      and organization_id = get_user_org_id()   -- refuse a foreign p_org_id
      and coalesce(custom_fields ->> 'merged_into', '') = ''
  ),
  email_groups as (
    select 'email'::text as key_type, email_hash as key_hash,
           array_agg(id order by id) as lead_ids
    from active
    where email_hash is not null
    group by email_hash
    having count(*) > 1
  ),
  phone_groups as (
    select 'phone'::text as key_type, phone_hash as key_hash,
           array_agg(id order by id) as lead_ids
    from active
    where phone_hash is not null
    group by phone_hash
    having count(*) > 1
  )
  select * from email_groups
  union all
  select * from phone_groups
  limit p_limit;
$$;

-- ── human_tasks.kind += 'duplicate_review' ─────────────────────────────────
-- CONSTRAINT REPLAY: every migration touching human_tasks_kind_check recreates
-- the FULL list. This carries every kind added before 'duplicate_review'. Do
-- not trim. Guarded + idempotent.
do $$
begin
  if to_regclass('public.human_tasks') is not null then
    alter table public.human_tasks drop constraint if exists human_tasks_kind_check;
    alter table public.human_tasks add constraint human_tasks_kind_check check (kind in (
      'inbound_reply', 'first_touch', 'nurture_step', 'stage_automation',
      'recommendation', 'sla_breach_review', 'call_review', 'list_call', 'manual',
      'follow_up', 'callback', 'duplicate_review'
    ));
  end if;
end $$;
