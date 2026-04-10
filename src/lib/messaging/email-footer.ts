/**
 * CAN-SPAM compliant email footer.
 * Required for all marketing/campaign emails.
 */

/**
 * Generate an unsubscribe token for a lead.
 */
export function generateUnsubscribeToken(leadId: string, orgId: string): string {
  return Buffer.from(`${leadId}:${orgId}`).toString('base64')
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
  }
): string {
  const unsubscribeUrl = getUnsubscribeUrl(options.leadId, options.orgId)

  const footer = `
    <div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e7eb;">
      <p style="color: #9ca3af; font-size: 11px; line-height: 1.5; text-align: center;">
        ${options.orgName}<br>
        You received this email because you submitted an inquiry with us.<br>
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
