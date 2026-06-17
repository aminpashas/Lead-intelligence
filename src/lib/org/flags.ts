/**
 * Org feature flags — per-org dark-launch switchboard.
 *
 * Backed by `organizations.feature_flags jsonb` (default '{}'). Every flag
 * defaults OFF (absent key = false) so new behavior is opt-in per org. This is
 * the single source of truth for "is X turned on for this org".
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type OrgFeatureFlag =
  | 'consent_capture'          // Phase 1.2 — opt-in micro-flow for `unknown` leads
  | 'us_sms_enabled'           // Phase 1.3 — flipped on once 10DLC is VERIFIED
  | 'link_lender_tracking'     // Phase 2.B — staff outcome entry for link lenders
  | 'lender_api_cherry'        // Phase 2.A
  | 'lender_api_alpheon'       // Phase 2.A
  | 'autonomous_reengagement'  // Phase 3
  | 'competitor_intel'         // Phase 4
  | 'org_goals'                // Phase 5
  | 'business_alerts'          // Phase 5

export type OrgFlags = Partial<Record<OrgFeatureFlag, boolean>>

/** Read all feature flags for an org. Returns {} on any error (fail-closed: flags read as OFF). */
export async function getOrgFlags(
  supabase: SupabaseClient,
  organizationId: string
): Promise<OrgFlags> {
  const { data, error } = await supabase
    .from('organizations')
    .select('feature_flags')
    .eq('id', organizationId)
    .maybeSingle<{ feature_flags: OrgFlags | null }>()

  if (error || !data?.feature_flags || typeof data.feature_flags !== 'object') return {}
  return data.feature_flags
}

/** Convenience: is a single flag enabled for this org? Defaults to false. */
export async function isFlagEnabled(
  supabase: SupabaseClient,
  organizationId: string,
  flag: OrgFeatureFlag
): Promise<boolean> {
  const flags = await getOrgFlags(supabase, organizationId)
  return flags[flag] === true
}

/** Pure helper for callers that already loaded the flags object. */
export function flagOn(flags: OrgFlags | null | undefined, flag: OrgFeatureFlag): boolean {
  return flags?.[flag] === true
}
