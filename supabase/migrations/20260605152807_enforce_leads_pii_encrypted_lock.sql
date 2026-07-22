-- DRIFT RECONCILIATION — captured verbatim from
-- supabase_migrations.schema_migrations version 20260605152807 (applied to prod,
-- no local file). See docs/MIGRATION_DRIFT.md.
--
-- Adds the chk_leads_pii_encrypted CHECK: email / phone / phone_formatted /
-- insurance_provider must each be NULL or `enc::`-prefixed. Guarded so it only
-- fires once all rows are clean and the constraint doesn't already exist.
--
-- NOTE (scope): the constraint deliberately does NOT cover date_of_birth — it is
-- a `date` column and cannot hold an `enc::` string, so DOB is stored as a plain
-- calendar date, not encrypted at rest. (The unit test asserting DOB is
-- `enc::`-prefixed is aspirational and does not match the enforced schema.) See
-- [[empty-string-pii-constraint-trap]] for the '' → NULL handling in encryptField.

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
    raise notice 'Skipping: % plaintext lead row(s) remain.', plaintext_count;
  elsif exists (select 1 from pg_constraint where conname = 'chk_leads_pii_encrypted') then
    raise notice 'chk_leads_pii_encrypted already exists.';
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
