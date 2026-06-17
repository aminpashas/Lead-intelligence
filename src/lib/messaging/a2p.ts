/**
 * A2P 10DLC campaign status helpers.
 *
 * US SMS is gated on the Twilio us_app_to_person campaign reaching VERIFIED.
 * The status monitor cron snapshots campaign + brand status and alerts on
 * transition. This module holds the pure transition logic so it's unit-testable
 * independent of the Twilio SDK.
 */

export type A2pSeverity = 'none' | 'info' | 'good' | 'critical'

export interface A2pTransition {
  changed: boolean
  severity: A2pSeverity
  message: string
}

/**
 * Decide whether the campaign status changed since last check and how loud to be.
 *   → VERIFIED   = good (US SMS can be enabled)
 *   → FAILED     = critical (resubmission needed)
 *   → any other change = info
 * No change, or no status returned, is silent.
 */
export function detectA2pTransition(
  prev: string | null | undefined,
  next: string | null | undefined
): A2pTransition {
  if (!next) return { changed: false, severity: 'none', message: 'no campaign status returned' }
  if (prev === next) return { changed: false, severity: 'none', message: `unchanged: ${next}` }

  const norm = next.toUpperCase()
  if (norm === 'VERIFIED') {
    return {
      changed: true,
      severity: 'good',
      message: `:white_check_mark: A2P 10DLC campaign is now *VERIFIED* (was ${prev ?? 'unknown'}). US SMS can be enabled (flip org flag \`us_sms_enabled\`).`,
    }
  }
  if (norm === 'FAILED') {
    return {
      changed: true,
      severity: 'critical',
      message: `:rotating_light: A2P 10DLC campaign *FAILED* (was ${prev ?? 'unknown'}). US SMS stays blocked until resubmitted.`,
    }
  }
  return {
    changed: true,
    severity: 'info',
    message: `:information_source: A2P 10DLC campaign status: ${prev ?? 'unknown'} → *${next}*.`,
  }
}
