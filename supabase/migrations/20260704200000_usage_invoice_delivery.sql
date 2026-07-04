-- Usage-invoice delivery + lifecycle.
--
-- Adds delivery/lifecycle columns to usage_invoices so an invoice can move draft → issued → sent
-- (emailed) → paid, and we can record how/when it was delivered. Status transitions are performed
-- by the agency invoices management UI; sent_at/sent_via are stamped by the email-send route.

alter table public.usage_invoices
  add column if not exists sent_at timestamptz,
  add column if not exists sent_via text,
  add column if not exists paid_at timestamptz;

comment on column public.usage_invoices.sent_via is 'Delivery channel of the last send, e.g. email:owner@practice.com';

-- A practice should keep seeing an invoice after it's marked paid, not just while 'issued'.
drop policy if exists "Practices read own issued usage_invoices" on public.usage_invoices;
create policy "Practices read own issued usage_invoices"
  on public.usage_invoices for select
  using (organization_id = public.get_user_org_id() and status in ('issued', 'paid'));
