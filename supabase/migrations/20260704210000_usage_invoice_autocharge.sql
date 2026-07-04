-- Usage-invoice auto-charging (agency ← practice) via Stripe.
--
-- This is a NET-NEW billing relationship: the agency charges the practice for LI usage on the
-- platform Stripe account. It is distinct from the existing Connect flow (patient → practice) and
-- from the subscription columns on `organizations` (which are missing in prod — migration 037
-- drift). So the practice's platform billing customer + card + autocharge flag live on
-- `billing_settings` (this repo's own table), decoupled from that drift.
--
-- Ships DORMANT: autocharge defaults false and nothing charges until a card is on file AND the flag
-- is turned on for that practice.

alter table public.billing_settings
  add column if not exists autocharge boolean not null default false,
  add column if not exists stripe_customer_id text,       -- practice's customer on the platform account
  add column if not exists stripe_default_pm_id text;      -- saved card to charge off-session

alter table public.usage_invoices
  add column if not exists stripe_invoice_id text,
  add column if not exists hosted_invoice_url text,
  add column if not exists charged_at timestamptz,
  add column if not exists charge_error text;

comment on column public.billing_settings.autocharge is
  'When true AND a card is on file, the monthly cron auto-charges this practice''s usage invoice.';
