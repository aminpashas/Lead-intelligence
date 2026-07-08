import { PAID_AD_CHANNELS } from '@/lib/attribution'

/**
 * Intake stage routing for the DGS lead bridge (`/api/v1/leads`).
 *
 * Problem this solves: for practices that only want *fresh paid demand* on the
 * "New Lead" board, the bridge would otherwise drop every bridged lead —
 * WhatConverts organic, GoHighLevel imports, GMB/mother-line call-tracking, an
 * imported nurturing database — into the default (New Lead) stage, burying the
 * handful of real Google/Meta ad leads under thousands of non-ad rows.
 *
 * Rule: for an allow-listed org, a brand-NEW lead whose resolved acquisition
 * channel is NOT a paid Google/Meta ad is routed straight into the org's
 * "Nurturing" stage instead of the default. Everything paid
 * (`PAID_AD_CHANNELS`) still lands in New Lead. This mirrors the exact
 * definition the acquisition KPIs already use (`PAID_AD_CHANNELS` in
 * `attribution.ts`), so the board and the "new leads" metric agree.
 *
 * Scope & safety:
 *  - Applies ONLY to the DGS bridge — genuine hot inbounds (a CallRail phone
 *    call, a direct website form fill) are intentionally left on the default
 *    stage by their own webhooks.
 *  - Only affects NEW inserts. Dedup hits keep whatever stage they reached.
 *  - Gated by `NEW_LEAD_PAID_ONLY_ORG_IDS` (comma-separated org UUIDs).
 *    Default-empty ⇒ no org is affected ⇒ zero behaviour change until a
 *    practice explicitly opts in.
 */

/** Slug of the fallback stage non-paid intake is routed to. */
export const NURTURE_STAGE_SLUG = 'nurturing'

const ENV_VAR = 'NEW_LEAD_PAID_ONLY_ORG_IDS'

/** Parse the comma-separated org allowlist from the environment (lower-cased). */
export function paidOnlyIntakeOrgIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env[ENV_VAR] ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  )
}

/** Is this org opted in to paid-only New Lead intake routing? */
export function isPaidOnlyIntakeOrg(
  orgId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return paidOnlyIntakeOrgIds(env).has(orgId.trim().toLowerCase())
}

const PAID = new Set<string>(PAID_AD_CHANNELS)

/**
 * Decide whether a new bridged lead should skip "New Lead" and go to Nurturing.
 *
 * Returns the target stage slug to look up (`'nurturing'`), or `null` to keep
 * the caller's default (New Lead) stage. Pure/DB-free so it is unit-testable.
 *
 * @param channel resolved `campaign_attribution.channel` (DGS-authoritative or
 *                the utm fallback), or null/unknown when it could not be resolved.
 */
export function routedIntakeStageSlug(
  orgId: string,
  channel: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): typeof NURTURE_STAGE_SLUG | null {
  if (!isPaidOnlyIntakeOrg(orgId, env)) return null
  const c = (channel ?? '').trim().toLowerCase()
  // Paid Google/Meta stays on New Lead; everything else (organic, GMB, social,
  // referral, direct, and unresolved/null) is nurture intake.
  return PAID.has(c) ? null : NURTURE_STAGE_SLUG
}
