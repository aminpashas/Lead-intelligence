/**
 * Per-campaign financing pre-qualification precedence.
 *
 * The account has an org-level switch (`financing_prequal_enabled`). A campaign
 * can now carry its own `prequal_mode` ('inherit' | 'enabled' | 'disabled').
 * This module resolves the two into a single yes/no for whether prequal may be
 * sent for a given lead's active campaign.
 *
 * Both the manual "Send Pre-Qual" route and the AI readiness auto-trigger call
 * resolvePrequalEligibility() so the campaign layer is honored everywhere.
 */

import type { CampaignPlaybook } from '@/types/database'

export type PrequalMode = NonNullable<CampaignPlaybook['prequal_mode']>

export interface PrequalEligibilityInput {
  /** Is `financing_prequal_enabled` on for this org? (the account default) */
  orgFlagOn: boolean
  /**
   * The active campaign's prequal_mode, or null when the lead is in no active
   * campaign (the default-deny "unenrolled" state — treat as 'inherit').
   */
  campaignMode: PrequalMode | null
}

/**
 * Decide whether financing pre-qualification is allowed for this lead.
 *
 * TODO(you): implement the precedence rule. This is a business-policy decision
 * with real trade-offs — that's why it lives in its own tiny, tested function
 * rather than being inlined at the two call sites.
 *
 * The three modes and the questions to settle:
 *   • 'inherit'  → follow `orgFlagOn` verbatim. (Straightforward.)
 *   • 'disabled' → should a campaign be able to VETO an org that's turned on?
 *                  (Recommended: yes — a campaign opting out is a safety choice.)
 *   • 'enabled'  → can a campaign turn prequal ON when the ORG flag is OFF?
 *                  Two philosophies:
 *                    (a) "tighten-only" — campaign can only ever narrow, never
 *                        widen: 'enabled' still requires the org flag on. Safer;
 *                        the account switch stays the master kill-switch.
 *                    (b) "campaign-authoritative" — an explicit 'enabled' opts
 *                        in even when the org default is off. More flexible;
 *                        weakens the account-level guarantee.
 *   • campaignMode === null → the lead is in no active campaign; treat it as
 *                             'inherit' (fall back to the org flag).
 *
 * Return `true` if prequal may be sent, `false` otherwise.
 */
export function resolvePrequalEligibility(input: PrequalEligibilityInput): boolean {
  const { orgFlagOn, campaignMode } = input
  const mode: PrequalMode = campaignMode ?? 'inherit'

  // Tighten-only policy: a campaign can VETO ('disabled') but never widen. The
  // account switch stays the master kill-switch, consistent with the codebase's
  // default-deny financing posture. So 'enabled' and 'inherit' both defer to the
  // org flag; only 'disabled' overrides it (always to off).
  if (mode === 'disabled') return false
  return orgFlagOn
}
