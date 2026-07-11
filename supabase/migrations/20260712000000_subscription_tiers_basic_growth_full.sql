-- Widen organizations.subscription_tier to the new sellable ladder (basic | growth | full)
-- while keeping 'trial' and the legacy tiers (starter/professional/enterprise) valid so existing
-- subscriptions and historical rows are never orphaned by the CHECK.
--
-- The original constraint was declared inline in 001_organizations_and_users.sql, so Postgres
-- named it `organizations_subscription_tier_check`. Drop-if-exists guards a differently-named
-- constraint on replay; the DO block below then removes any other CHECK still referencing the
-- column before we add the widened one, so this is safe to re-run.

alter table organizations
  drop constraint if exists organizations_subscription_tier_check;

do $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
    where rel.relname = 'organizations'
      and con.contype = 'c'
      and att.attname = 'subscription_tier'
  loop
    execute format('alter table organizations drop constraint %I', c.conname);
  end loop;
end $$;

alter table organizations
  add constraint organizations_subscription_tier_check
  check (subscription_tier in (
    'trial',
    'basic', 'growth', 'full',
    'starter', 'professional', 'enterprise'
  ));
