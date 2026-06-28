-- Migration: Add Stripe billing columns to organizations
-- Enables SaaS subscription management via Stripe Checkout + Customer Portal

alter table public.organizations
  add column if not exists stripe_customer_id text unique,
  add column if not exists stripe_subscription_id text unique;

create index if not exists idx_organizations_stripe_customer
  on public.organizations(stripe_customer_id)
  where stripe_customer_id is not null;

comment on column public.organizations.stripe_customer_id is 'Stripe Customer ID (cus_*) for SaaS billing';
comment on column public.organizations.stripe_subscription_id is 'Stripe Subscription ID (sub_*) for active plan';
