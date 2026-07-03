/**
 * Consent-capture flow helpers (Phase 1.2).
 *
 * Pure logic for the opt-in token lifecycle + the opt-in email body, kept free of
 * I/O so it's unit-testable. The API routes (request/confirm) do the DB work.
 */

import { randomBytes } from 'crypto'

/** Opt-in links stay valid for a week — long enough for a delayed email open. */
export const CONSENT_TOKEN_TTL_HOURS = 168

export type ConsentCaptureChannel = 'sms' | 'email' | 'voice'

/** URL-safe high-entropy token (no DB collision risk; also unguessable). */
export function generateConsentToken(): string {
  return randomBytes(24).toString('base64url')
}

export function consentTokenExpiry(now: Date = new Date()): string {
  return new Date(now.getTime() + CONSENT_TOKEN_TTL_HOURS * 3600 * 1000).toISOString()
}

export type TokenUsability =
  | { usable: true }
  | { usable: false; reason: 'expired' | 'already_used' }

/** A token is usable once: pending and not past its expiry. */
export function isTokenUsable(
  token: { status: string; expires_at: string },
  now: Date = new Date()
): TokenUsability {
  if (token.status === 'confirmed') return { usable: false, reason: 'already_used' }
  if (new Date(token.expires_at).getTime() < now.getTime()) return { usable: false, reason: 'expired' }
  return { usable: true }
}

export function buildOptInUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, '')}/optin/${token}`
}

/**
 * Map confirmed channels → the `leads` consent columns to set. Only ever sets
 * booleans TRUE (a confirmation is always a grant); status follows via trigger.
 */
export function consentGrantFields(
  channels: ConsentCaptureChannel[],
  now: string = new Date().toISOString(),
  source = 'optin_page'
): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  if (channels.includes('sms')) {
    fields.sms_consent = true
    fields.sms_consent_at = now
    fields.sms_consent_source = source
  }
  if (channels.includes('email')) {
    fields.email_consent = true
    fields.email_consent_at = now
    fields.email_consent_source = source
  }
  if (channels.includes('voice')) {
    // Voice = TCPA prior express WRITTEN consent for automated / AI-voice calls.
    // Only ever granted from an affirmative opt-in confirmation whose page
    // disclosed automated calls (see optInEmailTemplate + /optin disclosure).
    fields.voice_consent = true
    fields.voice_consent_at = now
    fields.voice_consent_source = source
  }
  return fields
}

/**
 * Map opted-out channels → the `leads` columns to set. Only ever sets the hard
 * opt-out boolean TRUE + a timestamp; the sync_consent_status trigger flips
 * status to 'declined' and log_consent_change appends the revoke to consent_log.
 * This is the inverse of consentGrantFields and is what gives LI a real,
 * timestamped opt-out record (vs. the status-only 'declined' the bridge wrote).
 */
export function consentRevokeFields(
  channels: ConsentCaptureChannel[],
  now: string = new Date().toISOString()
): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  if (channels.includes('sms')) {
    fields.sms_opt_out = true
    fields.sms_opt_out_at = now
  }
  if (channels.includes('email')) {
    fields.email_opt_out = true
    fields.email_opt_out_at = now
  }
  if (channels.includes('voice')) {
    fields.voice_opt_out = true
    fields.voice_opt_out_at = now
  }
  return fields
}

/**
 * Staff-facing DND channels. Distinct from ConsentCaptureChannel only in naming:
 * the UI says "call" where the consent model says "voice", so the mapping is
 * explicit here rather than leaking 'voice' into button labels.
 */
export type DndChannel = 'sms' | 'email' | 'call'

export const DND_CHANNELS: readonly DndChannel[] = ['sms', 'email', 'call'] as const

const DND_CHANNEL_COLUMN: Record<DndChannel, { flag: string; at: string }> = {
  sms: { flag: 'sms_opt_out', at: 'sms_opt_out_at' },
  email: { flag: 'email_opt_out', at: 'email_opt_out_at' },
  // "Calls" DND = the per-lead voice opt-out. The national-registry `do_not_call`
  // flag is a separate, non-toggleable signal and is intentionally left alone.
  call: { flag: 'voice_opt_out', at: 'voice_opt_out_at' },
}

/**
 * Staff DND toggle → the `leads` opt-out columns. `enabled: true` sets the hard
 * opt-out (+ timestamp), identical to a lead's own STOP, so every send path
 * already blocks on it. `enabled: false` clears it — a staff member lifting a
 * suppression. Consent booleans are deliberately NOT touched: lifting DND only
 * removes the block, it never manufactures consent. The sync_consent_status /
 * log_consent_change triggers keep tri-state status + consent_log in sync either
 * way. Per-channel by construction — passing ['sms'] leaves email/voice untouched.
 */
export function dndFields(
  channels: DndChannel[],
  enabled: boolean,
  now: string = new Date().toISOString()
): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const ch of channels) {
    const col = DND_CHANNEL_COLUMN[ch]
    fields[col.flag] = enabled
    fields[col.at] = enabled ? now : null
  }
  return fields
}

const CHANNEL_REACH_VERB: Record<ConsentCaptureChannel, string> = {
  sms: 'text',
  email: 'email',
  voice: 'call',
}

const CHANNEL_DISCLOSURE_NOUN: Record<ConsentCaptureChannel, string> = {
  sms: 'texts',
  email: 'emails',
  voice: 'phone calls (including calls placed using an automated system or AI voice)',
}

/** Oxford-style join of distinct phrases: ['a','b','c'] → 'a, b, and c'. */
function oxfordJoin(parts: string[]): string {
  const list = parts.filter(Boolean)
  if (list.length <= 1) return list[0] ?? ''
  if (list.length === 2) return `${list[0]} and ${list[1]}`
  return `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`
}

/** Human verb phrase for how we'll reach them: ['sms','voice'] → 'text and call'. */
export function optInReachPhrase(channels: ConsentCaptureChannel[]): string {
  const list = channels.length ? channels : (['sms', 'email'] as ConsentCaptureChannel[])
  return oxfordJoin(list.map((c) => CHANNEL_REACH_VERB[c]))
}

/** Disclosure noun phrase (what they consent to receive), incl. the AI-voice clause. */
export function optInDisclosurePhrase(channels: ConsentCaptureChannel[]): string {
  const list = channels.length ? channels : (['sms', 'email'] as ConsentCaptureChannel[])
  return oxfordJoin(list.map((c) => CHANNEL_DISCLOSURE_NOUN[c]))
}

/**
 * The full disclosure sentence shown on the /optin page. Rendered on the page AND
 * stored verbatim as the consent artifact at confirm time — both call this so the
 * record can never drift from what the patient actually saw.
 */
export function optInDisclosureSentence(channels: ConsentCaptureChannel[], orgName?: string | null): string {
  const org = orgName?.trim() || 'our team'
  return `By confirming you agree to receive automated marketing ${optInDisclosurePhrase(channels)} from ${org}. Consent is not a condition of any purchase or treatment. Message & data rates may apply. Reply STOP to any text to opt out at any time.`
}

/**
 * TCPA/CAN-SPAM-friendly opt-in email. Copy is channel-aware: when 'voice' is
 * among the channels, the disclosure explicitly authorizes automated / AI phone
 * calls — required for the confirmation to count as valid voice consent.
 */
export function optInEmailTemplate(p: {
  orgName: string
  firstName?: string | null
  url: string
  channels?: ConsentCaptureChannel[]
}): { subject: string; html: string; text: string } {
  const name = p.firstName?.trim() || 'there'
  const org = p.orgName?.trim() || 'our team'
  const channels = p.channels?.length ? p.channels : (['sms', 'email'] as ConsentCaptureChannel[])
  const reach = optInReachPhrase(channels)           // e.g. "text, email, and call"
  const disclosed = optInDisclosurePhrase(channels)  // e.g. "texts, emails, and phone calls (…AI voice)"
  const subject = `Confirm how ${org} can reach you`
  const disclosure = `By confirming you agree to receive automated marketing ${disclosed} from ${org}. Consent is not a condition of any purchase or treatment. Message & data rates may apply. Reply STOP to a text to opt out at any time. If you didn't request this, you can ignore this email.`
  const disclosureHtml = disclosure.replace(/&/g, '&amp;')
  const text = [
    `Hi ${name},`,
    ``,
    `You recently reached out about treatment with ${org}. To let our care team ${reach} you with appointment details, financing options, and answers to your questions, please confirm here:`,
    ``,
    p.url,
    ``,
    disclosure,
  ].join('\n')
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;color:#1f1a15">
      <p>Hi ${name},</p>
      <p>You recently reached out about treatment with <strong>${org}</strong>. To let our care team ${reach} you with appointment details, financing options, and answers to your questions, please confirm below:</p>
      <p style="text-align:center;margin:28px 0">
        <a href="${p.url}" style="background:#dc2626;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">Yes, you can contact me</a>
      </p>
      <p style="font-size:12px;color:#78716c">${disclosureHtml}</p>
    </div>`
  return { subject, html, text }
}
