/**
 * Google Business Profile — Review Request Connector
 *
 * Automates review requests to patients who complete treatment.
 * When a lead reaches "treatment.completed" or "contract.signed",
 * sends them a personalized SMS/email with the practice's Google review link.
 *
 * This isn't a Google API integration — it's a CRM automation that
 * generates review request messages using the practice's Google Maps URL.
 *
 * Configuration:
 * - google_place_id: The practice's Google Place ID
 * - review_url: Direct Google review URL (generated from Place ID)
 * - message_template: Custom SMS/email template for review requests
 * - delay_hours: Hours after treatment completion to send the request
 */

import type { ConnectorEvent, ConnectorResult } from '../types'

export type GoogleReviewConfig = {
  /** Google Place ID for the practice */
  placeId: string
  /** Direct review URL — auto-generated from placeId if not provided */
  reviewUrl?: string
  /** Custom SMS template for review request */
  smsTemplate?: string
  /** Custom email subject */
  emailSubject?: string
  /** Custom email template */
  emailTemplate?: string
  /** Hours to wait after the triggering event before sending (default: 2) */
  delayHours?: number
  /** Whether to send via SMS, email, or both */
  channels?: ('sms' | 'email')[]
}

/**
 * Generate a Google Review URL from a Place ID.
 * This creates a direct link that opens the review dialog on Google Maps.
 */
export function getGoogleReviewUrl(placeId: string): string {
  return `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`
}

/**
 * Build the default SMS template for review requests.
 */
function defaultSmsTemplate(reviewUrl: string): string {
  return [
    'Hi {{first_name}}! 🎉',
    '',
    'We loved caring for you at {{practice_name}}. Would you mind taking 30 seconds to share your experience?',
    '',
    `⭐ Leave a review: ${reviewUrl}`,
    '',
    'Your feedback helps other patients find quality care. Thank you!',
  ].join('\n')
}

/**
 * Build the default email template for review requests.
 */
function defaultEmailTemplate(reviewUrl: string): string {
  return `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 24px;">
  <h2 style="color: #1a1a1a; font-size: 24px; margin-bottom: 8px;">How was your experience? 🌟</h2>
  <p style="color: #666; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
    Hi {{first_name}}, thank you for choosing {{practice_name}}! We hope you had a wonderful experience.
  </p>
  <p style="color: #666; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
    Your feedback means the world to us and helps other patients find quality dental care. Would you mind sharing your experience on Google?
  </p>
  <div style="text-align: center; margin: 32px 0;">
    <a href="${reviewUrl}" style="display: inline-block; background: #1a73e8; color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-size: 16px; font-weight: 600;">
      ⭐ Leave a Review
    </a>
  </div>
  <p style="color: #999; font-size: 13px; text-align: center;">
    It only takes about 30 seconds. Thank you for your time!
  </p>
</div>`
}

/**
 * Process a review request event.
 *
 * This connector doesn't send anything directly — it returns the
 * review request data for the CRM to schedule via SMS/email channels.
 *
 * Events that trigger review requests:
 * - treatment.completed
 * - contract.signed (optional, for immediate feedback)
 */
export async function processReviewRequest(
  event: ConnectorEvent,
  config: GoogleReviewConfig
): Promise<ConnectorResult & { reviewData?: ReviewRequestData }> {
  // Only trigger on completion events
  if (!['treatment.completed', 'contract.signed'].includes(event.type)) {
    return { connector: 'google_ads', success: true } // Skip silently
  }

  const { lead } = event.data

  // Need at least phone or email to send the request
  if (!lead.phone && !lead.email) {
    return {
      connector: 'google_ads',
      success: false,
      error: 'Lead has no phone or email for review request',
    }
  }

  const reviewUrl = config.reviewUrl || getGoogleReviewUrl(config.placeId)
  const channels = config.channels || ['sms', 'email']

  const reviewData: ReviewRequestData = {
    leadId: lead.id,
    reviewUrl,
    channels,
    delayHours: config.delayHours ?? 2,
  }

  // Build SMS message
  if (channels.includes('sms') && lead.phone) {
    const template = config.smsTemplate || defaultSmsTemplate(reviewUrl)
    reviewData.smsMessage = template
      .replace(/\{\{first_name\}\}/g, lead.firstName || 'there')
      .replace(/\{\{last_name\}\}/g, lead.lastName || '')
      .replace(/\{\{practice_name\}\}/g, '{{practice_name}}') // replaced later by CRM template engine
  }

  // Build email
  if (channels.includes('email') && lead.email) {
    const template = config.emailTemplate || defaultEmailTemplate(reviewUrl)
    reviewData.emailSubject = (config.emailSubject || 'How was your experience at {{practice_name}}? ⭐')
      .replace(/\{\{first_name\}\}/g, lead.firstName || 'there')
      .replace(/\{\{practice_name\}\}/g, '{{practice_name}}')
    reviewData.emailHtml = template
      .replace(/\{\{first_name\}\}/g, lead.firstName || 'there')
      .replace(/\{\{last_name\}\}/g, lead.lastName || '')
      .replace(/\{\{practice_name\}\}/g, '{{practice_name}}')
  }

  return {
    connector: 'google_ads', // Reusing type for now
    success: true,
    responseId: `review_${lead.id}`,
    reviewData,
  }
}

export type ReviewRequestData = {
  leadId: string
  reviewUrl: string
  channels: ('sms' | 'email')[]
  delayHours: number
  smsMessage?: string
  emailSubject?: string
  emailHtml?: string
}
