-- ============================================================================
-- Atomic lead dedup: unique partial index on (organization_id, email_hash)
-- ============================================================================
-- The lead-ingest paths (v1/leads, form webhook, qualify RPC) dedup with a
-- check-then-insert, which races under concurrent posts (e.g. a bulk re-sync or
-- a double-submit) → duplicate leads → duplicate AI first-touch texts.
--
-- A unique index makes email dedup atomic at the DB layer. The app paths now
-- catch the unique-violation (23505) and return the existing lead as a dedup hit.
--
-- NOTE: only EMAIL is made unique. Phone is intentionally NOT unique — multiple
-- people legitimately share a phone (spouses, a household line, a parent
-- submitting for a child), and a unique phone index would wrongly reject them.
--
-- Safety: if duplicate (org,email_hash) rows already exist, creating a unique
-- index would fail and block the deploy. This migration checks first and skips
-- (with a NOTICE) rather than failing — dedupe the existing rows, then re-run.
-- ============================================================================

do $$
declare
  dup_groups int;
begin
  select count(*) into dup_groups
  from (
    select organization_id, email_hash
    from public.leads
    where email_hash is not null
    group by organization_id, email_hash
    having count(*) > 1
  ) d;

  if dup_groups > 0 then
    raise notice 'Skipping unique email_hash index: % duplicate (org,email_hash) group(s) exist. Dedupe and re-run.', dup_groups;
  else
    drop index if exists public.idx_leads_email_hash;
    create unique index if not exists idx_leads_email_hash_uniq
      on public.leads(organization_id, email_hash)
      where email_hash is not null;
    raise notice 'Created unique index idx_leads_email_hash_uniq';
  end if;
end $$;
