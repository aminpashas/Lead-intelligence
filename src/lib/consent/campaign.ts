/**
 * Re-permission (consent-capture) campaign config + planning helpers.
 *
 * The batch cron (src/app/api/cron/consent-capture/route.ts) emails the hosted
 * /optin opt-in to a tagged segment of `unknown`-consent leads to EARN consent —
 * the lawful on-ramp before any automated SMS or AI-voice outreach. See
 * docs/re-permission-campaign-playbook.md.
 *
 * Pure helpers live here so the cron's budget/gating math is unit-testable.
 *
 * Safety: nothing real is sent unless the per-org `consent_capture` flag is ON
 * *and* the global CONSENT_CAPTURE_SEND env switch is 'true'. Otherwise the cron
 * dry-runs (reports who it WOULD email, mints no tokens, sends nothing).
 */

import type { ConsentCaptureChannel } from '@/lib/consent/capture'

/** Default segment tag for the full-arch cold re-permission pool. */
export const CONSENT_CAPTURE_REPERMISSION_TAG = 'full-arch-cold'

/**
 * Channels a confirmed opt-in grants. We capture all three so a single "yes"
 * unlocks email + SMS + AI-voice at once (the opt-in disclosure authorizes
 * automated calls/texts). The lead can still opt out of any channel later.
 */
export const CONSENT_CAPTURE_CHANNELS: ConsentCaptureChannel[] = ['email', 'sms', 'voice']

/** Don't re-permission (re-email) the same lead more than once per this window. */
export const CONSENT_CAPTURE_TOKEN_COOLDOWN_DAYS = 30

/** Conservative default daily send cap (email warmup ramp; override via env). */
export const CONSENT_CAPTURE_DEFAULT_DAILY_CAP = 250

/** Remaining send budget for a run: the daily cap minus what already went out today. */
export function consentCaptureBudget(dailyCap: number, sentToday: number): number {
  return Math.max(0, Math.trunc(dailyCap) - Math.max(0, Math.trunc(sentToday)))
}

/**
 * Global send switch. The cron only sends real email when this is exactly
 * 'true'; otherwise it dry-runs. Independent of (and AND-ed with) the per-org
 * `consent_capture` feature flag — both must be on to contact a real patient.
 */
export function consentCaptureSendEnabled(env: Record<string, string | undefined>): boolean {
  return env.CONSENT_CAPTURE_SEND === 'true'
}
