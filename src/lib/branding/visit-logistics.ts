import { escapeHtml } from '@/lib/utils'
import type { BrandLogistics } from '@/lib/branding/schema'

/**
 * Renders a brand's visit logistics (address, driving/BART directions, parking,
 * and "what to expect") into the three surfaces a confirmation needs. One
 * source of truth so public booking, staff booking, and reminders all read the
 * same — the whole point being that a patient who booked days ago still knows
 * WHO we are and HOW to get here, cutting no-shows.
 *
 * - `smsSuffix`  — short "where/how" line appended to the confirmation text.
 *                  Address + car + BART only; "what to expect" is email-only so
 *                  the SMS stays to one or two segments.
 * - `emailHtml`  — "Getting here" + "What to expect" cards (empty string if the
 *                  brand has no logistics entered yet).
 * - `emailText`  — plain-text mirror of the same, for the email's text part.
 */
export type RenderedLogistics = {
  smsSuffix: string
  emailHtml: string
  emailText: string
}

const has = (s: string | undefined): s is string => Boolean(s && s.trim())

// Accepts anything carrying a `logistics` block — a full ResolvedBrand or a bare
// `{ logistics }` (reminders resolve org-shared logistics without a per-lead brand).
export function renderVisitLogistics(brand: { logistics: BrandLogistics }): RenderedLogistics {
  const { addressText, drivingText, parkingText, transitText, whatToExpectText } = brand.logistics

  // ── SMS: address + concise car/BART hints (what-to-expect stays in email) ──
  const smsSuffix = [
    addressText,
    has(drivingText) ? `By car: ${drivingText}` : '',
    has(parkingText) ? `Parking: ${parkingText}` : '',
    has(transitText) ? `By BART: ${transitText}` : '',
  ]
    .filter((s) => has(s))
    .join(' ')
    .trim()

  // ── Email: "Getting here" card ──
  const gettingHereRows = [
    has(addressText) ? `<p style="margin: 4px 0;">${escapeHtml(addressText)}</p>` : '',
    has(drivingText) ? `<p style="margin: 4px 0;"><strong>By car:</strong> ${escapeHtml(drivingText)}</p>` : '',
    has(parkingText) ? `<p style="margin: 4px 0;"><strong>Parking:</strong> ${escapeHtml(parkingText)}</p>` : '',
    has(transitText) ? `<p style="margin: 4px 0;"><strong>By BART / transit:</strong> ${escapeHtml(transitText)}</p>` : '',
  ].filter(Boolean)

  const gettingHereHtml = gettingHereRows.length
    ? `
          <div style="background: #f4f8ff; padding: 16px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 0 0 8px; font-weight: 600;">Getting here</p>
            ${gettingHereRows.join('\n            ')}
          </div>`
    : ''

  // ── Email: "What to expect" card ──
  const whatToExpectHtml = has(whatToExpectText)
    ? `
          <div style="background: #f9f9f9; padding: 16px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 0 0 8px; font-weight: 600;">What to expect</p>
            <p style="margin: 4px 0; white-space: pre-line;">${escapeHtml(whatToExpectText)}</p>
          </div>`
    : ''

  const emailHtml = `${gettingHereHtml}${whatToExpectHtml}`

  // ── Email: plain-text mirror ──
  const emailTextParts = [
    gettingHereRows.length
      ? [
          'Getting here:',
          has(addressText) ? addressText : '',
          has(drivingText) ? `By car: ${drivingText}` : '',
          has(parkingText) ? `Parking: ${parkingText}` : '',
          has(transitText) ? `By BART / transit: ${transitText}` : '',
        ]
          .filter((s) => has(s))
          .join('\n')
      : '',
    has(whatToExpectText) ? `What to expect:\n${whatToExpectText}` : '',
  ].filter((s) => has(s))
  const emailText = emailTextParts.join('\n\n')

  return { smsSuffix, emailHtml, emailText }
}
