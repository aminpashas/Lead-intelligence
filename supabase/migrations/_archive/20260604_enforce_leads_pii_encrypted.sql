-- ============================================================================
-- Enforce PII encryption at rest on leads (text PII columns)
-- ============================================================================
-- Adds a CHECK constraint requiring leads.email / phone / phone_formatted /
-- insurance_provider to be either NULL or `enc::`-prefixed ciphertext, so a write
-- path that forgets to encrypt is rejected rather than silently storing plaintext.
--
-- Only the TEXT PII columns are covered: date_of_birth is a `date` column and
-- insurance_details is `jsonb`, so neither can hold the enc:: string form.
--
-- SAFE / non-breaking: if ANY plaintext rows still exist, adding the constraint
-- would fail and block the deploy — so this checks first and SKIPS (with a NOTICE)
-- when plaintext remains. Run src/scripts/backfill-pii-encryption.ts (DRY_RUN=false)
-- first, then re-run this migration to lock it in.
-- ============================================================================

do $$
declare
  plaintext_count int;
begin
  select count(*) into plaintext_count
  from public.leads
  where (email is not null and email not like 'enc::%')
     or (phone is not null and phone not like 'enc::%')
     or (phone_formatted is not null and phone_formatted not like 'enc::%')
     or (insurance_provider is not null and insurance_provider not like 'enc::%');

  if plaintext_count > 0 then
    raise notice 'Skipping PII CHECK constraint: % lead row(s) still hold plaintext PII. Run the backfill, then re-run.', plaintext_count;
  elsif exists (
    select 1 from pg_constraint where conname = 'chk_leads_pii_encrypted'
  ) then
    raise notice 'chk_leads_pii_encrypted already exists — nothing to do.';
  else
    alter table public.leads add constraint chk_leads_pii_encrypted check (
      (email is null or email like 'enc::%')
      and (phone is null or phone like 'enc::%')
      and (phone_formatted is null or phone_formatted like 'enc::%')
      and (insurance_provider is null or insurance_provider like 'enc::%')
    );
    raise notice 'Added chk_leads_pii_encrypted.';
  end if;
end $$;
