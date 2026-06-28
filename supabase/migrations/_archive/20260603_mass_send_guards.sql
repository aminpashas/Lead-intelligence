-- ============================================================================
-- Mass-send guardrails: idempotency keys for /api/sms/mass and /api/email/mass
-- ============================================================================
-- Without an idempotency mechanism, a retried mass-send POST (client retry,
-- proxy retry, double-click) re-sends the ENTIRE batch — real Twilio/Resend
-- spend and duplicate messages to every recipient.
--
-- This table is the atomic claim ledger: the route INSERTs (org, key) BEFORE
-- sending. The PRIMARY KEY makes a duplicate retry's INSERT fail on conflict,
-- so exactly one request proceeds. The per-org daily cap is enforced in
-- application code by counting today's outbound `messages`.
-- ============================================================================

create table if not exists public.mass_send_idempotency (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  idempotency_key text not null,
  route text not null,
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (organization_id, idempotency_key)
);

create index if not exists idx_mass_send_idem_created
  on public.mass_send_idempotency(created_at);

alter table public.mass_send_idempotency enable row level security;

-- The mass-send routes run under the caller's auth context (RLS on), so org
-- members must be able to claim/read their own org's keys.
drop policy if exists "org_manage_mass_send_idem" on public.mass_send_idempotency;
create policy "org_manage_mass_send_idem"
  on public.mass_send_idempotency for all
  using (organization_id in (select organization_id from public.user_profiles where id = auth.uid()))
  with check (organization_id in (select organization_id from public.user_profiles where id = auth.uid()));

drop policy if exists "service_role_mass_send_idem" on public.mass_send_idempotency;
create policy "service_role_mass_send_idem"
  on public.mass_send_idempotency for all
  to service_role
  using (true) with check (true);
