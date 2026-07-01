import { flagOn, type OrgFlags } from '@/lib/org/flags'

/**
 * A2P 10DLC (US SMS) gate.
 *
 * US carriers filter/blocklist SMS from unregistered 10DLC senders. Until the
 * org's 10DLC campaign is VERIFIED, US SMS must be hard-blocked. The
 * `us_sms_enabled` org feature flag is the single source of truth (flipped on
 * once verification lands); everything else fails closed.
 */

/** User-facing copy shown wherever US SMS is paused for pending 10DLC registration. */
export const A2P_PENDING_MESSAGE =
  'US SMS is paused while 10DLC (A2P) registration is pending verification. Email still works.'

/**
 * True when US SMS is blocked for this org. Fail-closed: a missing/unknown flag
 * reads as blocked. Flip `us_sms_enabled` on once 10DLC is VERIFIED to lift it.
 */
export function isUsSmsBlocked(flags: OrgFlags | null | undefined): boolean {
  return !flagOn(flags, 'us_sms_enabled')
}
