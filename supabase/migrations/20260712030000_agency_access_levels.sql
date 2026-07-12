-- ============================================================================
-- 20260712030000 — Agency access levels (owner / manager / analyst)
-- ============================================================================
-- Introduces graduated agency staff tiers WITHOUT adding new role values.
--
-- Every agency staffer keeps `role = 'agency_admin'`, so all existing RLS,
-- enter-account (agency_active_org), and the privilege-escalation guards
-- (20260627 / 20260707 — which only permit an existing agency_admin to mint
-- an agency_admin/owner row) continue to work UNCHANGED. Adding distinct role
-- values would fall outside those guards' protected set and open a new privesc
-- surface, so the tier lives in a dedicated column instead.
--
-- The owner/manager/analyst *limits* are enforced in the application layer
-- (see src/lib/auth/permissions.ts::agencyCan + requireAgencyCapability),
-- consistent with how the app already gates per-action powers. This column is
-- purely additive: NULL means "unset", which the app resolves to 'owner' for
-- backward compatibility with pre-existing agency admins.
-- ============================================================================

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS agency_access_level text
    CHECK (agency_access_level IN ('owner', 'manager', 'analyst'));

COMMENT ON COLUMN public.user_profiles.agency_access_level IS
  'Agency staff tier for role=agency_admin: owner (full), manager (operate '
  'practices + client teams), analyst (read-only). NULL = legacy admin, treated '
  'as owner by the app. Ignored for non-agency roles.';

-- Backfill: every existing agency admin becomes an owner (they had full control
-- before this migration, so preserve it).
UPDATE public.user_profiles
   SET agency_access_level = 'owner'
 WHERE role = 'agency_admin'
   AND agency_access_level IS NULL;

-- Defense-in-depth: keep the column meaningful only for agency staff. A row that
-- is not an agency_admin should not carry an agency tier.
UPDATE public.user_profiles
   SET agency_access_level = NULL
 WHERE role <> 'agency_admin'
   AND agency_access_level IS NOT NULL;
