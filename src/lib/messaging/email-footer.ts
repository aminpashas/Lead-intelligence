/**
 * CAN-SPAM compliant email footer.
 * Required for all marketing/campaign emails.
 */

import crypto from 'crypto'

function unsubSecret(): string {
  // Falls back to WEBHOOK_SECRET so a dedicated key is optional.
  return process.env.UNSUBSCRIBE_SECRET || process.env.WEBHOOK_SECRET || ''
}

/**
 * Generate a signed unsubscribe token: base64(leadId:orgId).hmac
 * The HMAC stops anyone from forging a token for an arbitrary lead (which would
 * let them suppress a competitor's deliverability). Legacy unsigned tokens are
 * still accepted by the route so links already in inboxes keep working.
 */
export function generateUnsubscribeToken(leadId: string, orgId: string): string {
  const payload = Buffer.from(`${leadId}:${orgId}`).toString('base64')
  const secret = unsubSecret()
  if (!secret) return payload // dev / unconfigured → legacy unsigned
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex').slice(0, 32)
  return `${payload}.${sig}`
}

/**
 * Verify an unsubscribe token's HMAC. Fail-closed: a token must carry a valid
 * signature. Previously this accepted any unsigned token (no '.') and any token
 * when no secret was configured — since the payload is just base64(leadId:orgId)
 * and those IDs are not secret, that let anyone forge a token for an arbitrary
 * lead and suppress a competitor org's deliverability (unauthenticated
 * cross-tenant write). WEBHOOK_SECRET is required in prod, so all legitimately
 * generated links are signed and continue to verify.
 */
export function verifyUnsubscribeToken(token: string): boolean {
  const secret = unsubSecret()
  if (!secret) return false // cannot verify without a secret → reject
  const dot = token.indexOf('.')
  if (dot < 0) return false // unsigned token → reject (was a forgery vector)
  const payload = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex').slice(0, 32)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/**
 * Generate the unsubscribe URL for a lead.
 */
export function getUnsubscribeUrl(leadId: string, orgId: string): string {
  const token = generateUnsubscribeToken(leadId, orgId)
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  return `${baseUrl}/api/email/unsubscribe?token=${token}`
}

/**
 * Append CAN-SPAM compliant footer to email HTML.
 * Includes: physical address, unsubscribe link, business name.
 */
export function appendEmailFooter(
  html: string,
  options: {
    leadId: string
    orgId: string
    orgName: string
    address?: string | null
  }
): string {
  const unsubscribeUrl = getUnsubscribeUrl(options.leadId, options.orgId)
  const addressLine = options.address ? `${options.address}<br>` : ''

  const footer = `
    <div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e7eb;">
      <p style="color: #9ca3af; font-size: 11px; line-height: 1.5; text-align: center;">
        ${options.orgName}<br>
        ${addressLine}You received this email because you submitted an inquiry with us.<br>
        <a href="${unsubscribeUrl}" style="color: #9ca3af; text-decoration: underline;">Unsubscribe</a> from future emails.
      </p>
    </div>`

  // Insert before closing div or append
  if (html.includes('</div>')) {
    const lastDivIndex = html.lastIndexOf('</div>')
    return html.slice(0, lastDivIndex) + footer + html.slice(lastDivIndex)
  }

  return html + footer
}

/**
 * Get List-Unsubscribe headers for email (RFC 8058 one-click unsubscribe).
 */
export function getUnsubscribeHeaders(leadId: string, orgId: string): Record<string, string> {
  const url = getUnsubscribeUrl(leadId, orgId)
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  }
}
