/**
 * Consent-capture flow helpers (Phase 1.2).
 *
 * Pure logic for the opt-in token lifecycle + the opt-in email body, kept free of
 * I/O so it's unit-testable. The API routes (request/confirm) do the DB work.
 */

import { randomBytes } from 'crypto'

/** Opt-in links stay valid for a week — long enough for a delayed email open. */
export const CONSENT_TOKEN_TTL_HOURS = 168

export type ConsentCaptureChannel = 'sms' | 'email'

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
  return fields
}

/** TCPA/CAN-SPAM-friendly opt-in email. */
export function optInEmailTemplate(p: {
  orgName: string
  firstName?: string | null
  url: string
}): { subject: string; html: string; text: string } {
  const name = p.firstName?.trim() || 'there'
  const org = p.orgName?.trim() || 'our team'
  const subject = `Confirm how ${org} can reach you`
  const text = [
    `Hi ${name},`,
    ``,
    `You recently reached out about treatment with ${org}. To let our care team text and email you with appointment details, financing options, and answers to your questions, please confirm here:`,
    ``,
    p.url,
    ``,
    `By confirming you agree to receive automated texts and emails from ${org}. Message & data rates may apply. Reply STOP to a text to opt out at any time. If you didn't request this, you can ignore this email.`,
  ].join('\n')
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;color:#1f1a15">
      <p>Hi ${name},</p>
      <p>You recently reached out about treatment with <strong>${org}</strong>. To let our care team text and email you with appointment details, financing options, and answers to your questions, please confirm below:</p>
      <p style="text-align:center;margin:28px 0">
        <a href="${p.url}" style="background:#dc2626;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">Yes, you can contact me</a>
      </p>
      <p style="font-size:12px;color:#78716c">By confirming you agree to receive automated texts and emails from ${org}. Message &amp; data rates may apply. Reply STOP to a text to opt out at any time. If you didn't request this, you can ignore this email.</p>
    </div>`
  return { subject, html, text }
}
