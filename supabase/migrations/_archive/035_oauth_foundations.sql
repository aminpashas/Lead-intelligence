-- Migration 027: OAuth foundations for connector integrations
--
-- Adds `oauth_states` — a short-lived CSRF state table used by the
-- Google and Meta OAuth flows. We generate a random state token when a
-- user clicks "Connect with Google/Meta", persist the (org, user, provider)
-- tuple here, and verify the callback hits our redirect with a state we
-- issued, not an attacker's. Rows expire after 15 minutes.
--
-- The actual OAuth exchange + credential storage still lands in
-- `connector_configs.credentials` (which is now encrypted at rest via
-- `src/lib/connectors/crypto.ts`). This table only holds the transient
-- state values — nothing sensitive.

create table if not exists public.oauth_states (
  -- The state token itself is the PK. 32 bytes base64url → ~43 chars.
  state text primary key,

  -- Which org + user initiated the flow. We scope tokens to the initiating
  -- user so stealing a state token from another tab can't cross-tenant.
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,

  -- 'google' covers the combined Ads + GA4 consent. 'meta' covers Business
  -- Login for Ads + CAPI. Adding more providers is an ALTER with a new
  -- value in the CHECK constraint.
  provider text not null check (provider in ('google', 'meta')),

  -- Optional hint for the callback handler — e.g. 'initial' vs 'reconnect'
  -- vs scope upgrade. Opaque JSON so we don't need migrations for new uses.
  metadata jsonb not null default '{}',

  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes')
);

-- Cleanup index for the TTL sweeper.
create index if not exists idx_oauth_states_expires_at
  on public.oauth_states (expires_at);

-- RLS: users can only see / create state tokens for their own org.
-- The callback handler (server-side, service role) bypasses RLS to look up
-- a state even if the user's session context has changed between request
-- and callback.
alter table public.oauth_states enable row level security;

create policy oauth_states_org_policy on public.oauth_states
  using (organization_id = get_user_org_id());

create policy oauth_states_service on public.oauth_states
  for all to service_role using (true) with check (true);
