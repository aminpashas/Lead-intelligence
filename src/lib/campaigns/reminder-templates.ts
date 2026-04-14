/**
 * Appointment Reminder Templates
 *
 * Premium HTML email templates and SMS copy for the multi-stage
 * appointment reminder sequence. All emails include CAN-SPAM
 * compliant footers and one-click confirmation buttons.
 */

// ═══════════════════════════════════════════════════════════════
// CONFIRMATION URL HELPERS
// ═══════════════════════════════════════════════════════════════

/**
 * Generate a tokenized confirmation URL for one-click email confirmation.
 */
export function generateConfirmationToken(appointmentId: string, orgId: string): string {
  return Buffer.from(`apt:${appointmentId}:${orgId}:${Date.now()}`).toString('base64url')
}

export function getConfirmationUrl(appointmentId: string, orgId: string): string {
  const token = generateConfirmationToken(appointmentId, orgId)
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001'
  return `${baseUrl}/api/appointments/confirm?token=${token}&action=confirm`
}

export function getRescheduleUrl(appointmentId: string, orgId: string): string {
  const token = generateConfirmationToken(appointmentId, orgId)
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001'
  return `${baseUrl}/api/appointments/confirm?token=${token}&action=reschedule`
}

// ═══════════════════════════════════════════════════════════════
// SHARED STYLES
// ═══════════════════════════════════════════════════════════════

const emailStyles = {
  container: 'font-family: "Inter", "Segoe UI", Roboto, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff; border: 1px solid #e5e7eb; border-radius: 12px; overflow: hidden;',
  header: 'background: linear-gradient(135deg, #1e3a5f 0%, #2563eb 100%); padding: 32px 24px; text-align: center;',
  headerTitle: 'color: #ffffff; font-size: 24px; font-weight: 700; margin: 0; line-height: 1.3;',
  headerSubtitle: 'color: rgba(255,255,255,0.85); font-size: 14px; margin-top: 8px;',
  body: 'padding: 32px 24px;',
  greeting: 'font-size: 16px; color: #1f2937; margin: 0 0 20px 0; line-height: 1.5;',
  detailCard: 'background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 20px; margin: 20px 0;',
  detailRow: 'display: flex; align-items: center; padding: 8px 0; font-size: 14px; color: #374151;',
  detailLabel: 'font-weight: 600; color: #1f2937; min-width: 120px; display: inline-block;',
  detailValue: 'color: #374151;',
  confirmBtn: 'display: inline-block; background: linear-gradient(135deg, #059669 0%, #10b981 100%); color: #ffffff; font-size: 16px; font-weight: 600; padding: 14px 36px; border-radius: 8px; text-decoration: none; margin: 8px 8px 8px 0;',
  rescheduleBtn: 'display: inline-block; background: #ffffff; color: #2563eb; font-size: 14px; font-weight: 600; padding: 12px 24px; border-radius: 8px; text-decoration: none; border: 2px solid #2563eb; margin: 8px 8px 8px 0;',
  footer: 'padding: 20px 24px; background: #f9fafb; border-top: 1px solid #e5e7eb; text-align: center;',
  footerText: 'font-size: 12px; color: #9ca3af; line-height: 1.6;',
  divider: 'border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;',
  checklistItem: 'padding: 6px 0; font-size: 14px; color: #374151;',
}

// ═══════════════════════════════════════════════════════════════
// 72-HOUR EMAIL TEMPLATE
// ═══════════════════════════════════════════════════════════════

export function generate72hEmailTemplate(params: {
  firstName: string
  appointmentType: string
  dateTime: string
  location?: string | null
  practiceName: string
  confirmUrl: string
  rescheduleUrl: string
}): { subject: string; html: string; text: string } {
  const { firstName, appointmentType, dateTime, location, practiceName, confirmUrl, rescheduleUrl } = params

  const subject = `Your ${appointmentType} at ${practiceName} — Confirm Your Appointment`

  const html = `
<div style="${emailStyles.container}">
  <div style="${emailStyles.header}">
    <h1 style="${emailStyles.headerTitle}">Your Appointment is Coming Up! 🗓️</h1>
    <p style="${emailStyles.headerSubtitle}">${practiceName}</p>
  </div>

  <div style="${emailStyles.body}">
    <p style="${emailStyles.greeting}">
      Hi ${firstName},
    </p>
    <p style="font-size: 15px; color: #4b5563; line-height: 1.6; margin: 0 0 16px 0;">
      We're looking forward to seeing you! Here are the details for your upcoming appointment:
    </p>

    <div style="${emailStyles.detailCard}">
      <div style="padding: 8px 0;">
        <span style="${emailStyles.detailLabel}">📋 Type:</span>
        <span style="${emailStyles.detailValue}">${appointmentType.charAt(0).toUpperCase() + appointmentType.slice(1)}</span>
      </div>
      <div style="padding: 8px 0;">
        <span style="${emailStyles.detailLabel}">📅 Date & Time:</span>
        <span style="font-weight: 600; color: #2563eb; font-size: 15px;">${dateTime}</span>
      </div>
      ${location ? `
      <div style="padding: 8px 0;">
        <span style="${emailStyles.detailLabel}">📍 Location:</span>
        <span style="${emailStyles.detailValue}">${location}</span>
      </div>
      ` : ''}
    </div>

    <div style="text-align: center; margin: 28px 0;">
      <a href="${confirmUrl}" style="${emailStyles.confirmBtn}">✅ Confirm Appointment</a>
      <a href="${rescheduleUrl}" style="${emailStyles.rescheduleBtn}">📅 Reschedule</a>
    </div>

    <hr style="${emailStyles.divider}" />

    <p style="font-size: 14px; font-weight: 600; color: #1f2937; margin: 0 0 12px 0;">
      📝 What to Bring
    </p>
    <div style="padding: 0 0 0 8px;">
      <div style="${emailStyles.checklistItem}">☑️ Photo ID (driver's license or passport)</div>
      <div style="${emailStyles.checklistItem}">☑️ Insurance card (if applicable)</div>
      <div style="${emailStyles.checklistItem}">☑️ List of current medications</div>
      <div style="${emailStyles.checklistItem}">☑️ Any relevant dental records or X-rays</div>
    </div>

    <hr style="${emailStyles.divider}" />

    <p style="font-size: 14px; font-weight: 600; color: #1f2937; margin: 0 0 12px 0;">
      ⏰ Arrival Tips
    </p>
    <p style="font-size: 14px; color: #4b5563; line-height: 1.6; margin: 0;">
      Please arrive <strong>15 minutes early</strong> to complete any necessary paperwork. 
      If you have any questions or need to make changes, don't hesitate to reply to this email or call us.
    </p>
  </div>

  <div style="${emailStyles.footer}">
    <p style="${emailStyles.footerText}">
      ${practiceName}<br>
      If you need to cancel or reschedule, please let us know at least 24 hours in advance.
    </p>
  </div>
</div>`

  const text = `Hi ${firstName},

Your ${appointmentType} at ${practiceName} is coming up!

📅 Date & Time: ${dateTime}
${location ? `📍 Location: ${location}` : ''}

Please confirm by visiting: ${confirmUrl}
Need to reschedule? ${rescheduleUrl}

What to bring:
- Photo ID
- Insurance card (if applicable)
- List of current medications
- Any relevant dental records or X-rays

Please arrive 15 minutes early.

— ${practiceName}`

  return { subject, html, text }
}

// ═══════════════════════════════════════════════════════════════
// 24-HOUR EMAIL TEMPLATE
// ═══════════════════════════════════════════════════════════════

export function generate24hEmailTemplate(params: {
  firstName: string
  appointmentType: string
  dateTime: string
  location?: string | null
  practiceName: string
  confirmUrl: string
  rescheduleUrl: string
}): { subject: string; html: string; text: string } {
  const { firstName, appointmentType, dateTime, location, practiceName, confirmUrl, rescheduleUrl } = params

  const subject = `⏰ Tomorrow: Your ${appointmentType} at ${practiceName}`

  const html = `
<div style="${emailStyles.container}">
  <div style="background: linear-gradient(135deg, #ea580c 0%, #f59e0b 100%); padding: 28px 24px; text-align: center;">
    <h1 style="${emailStyles.headerTitle}">Your Appointment is Tomorrow! ⏰</h1>
  </div>

  <div style="${emailStyles.body}">
    <p style="${emailStyles.greeting}">
      Hi ${firstName},
    </p>
    <p style="font-size: 15px; color: #4b5563; line-height: 1.6; margin: 0 0 20px 0;">
      Just a quick reminder — your appointment is <strong>tomorrow</strong>. We want to make sure we have everything ready for you!
    </p>

    <div style="${emailStyles.detailCard}">
      <div style="padding: 8px 0;">
        <span style="${emailStyles.detailLabel}">📋 Type:</span>
        <span style="${emailStyles.detailValue}">${appointmentType.charAt(0).toUpperCase() + appointmentType.slice(1)}</span>
      </div>
      <div style="padding: 8px 0;">
        <span style="${emailStyles.detailLabel}">📅 Date & Time:</span>
        <span style="font-weight: 700; color: #ea580c; font-size: 16px;">${dateTime}</span>
      </div>
      ${location ? `
      <div style="padding: 8px 0;">
        <span style="${emailStyles.detailLabel}">📍 Location:</span>
        <span style="${emailStyles.detailValue}">${location}</span>
      </div>
      ` : ''}
    </div>

    <div style="text-align: center; margin: 28px 0;">
      <a href="${confirmUrl}" style="${emailStyles.confirmBtn}">✅ Yes, I'll Be There!</a>
      <br style="display: block; margin: 4px 0;" />
      <a href="${rescheduleUrl}" style="${emailStyles.rescheduleBtn}">I Need to Reschedule</a>
    </div>

    <p style="font-size: 14px; color: #6b7280; text-align: center; margin: 16px 0 0 0;">
      You can also reply to this email or call us directly.
    </p>
  </div>

  <div style="${emailStyles.footer}">
    <p style="${emailStyles.footerText}">
      ${practiceName} — See you tomorrow! 😊
    </p>
  </div>
</div>`

  const text = `Hi ${firstName},

Quick reminder — your ${appointmentType} at ${practiceName} is TOMORROW!

📅 ${dateTime}
${location ? `📍 ${location}` : ''}

Please confirm: ${confirmUrl}
Need to reschedule? ${rescheduleUrl}

— ${practiceName}`

  return { subject, html, text }
}

// ═══════════════════════════════════════════════════════════════
// CONFIRMATION THANK YOU EMAIL
// ═══════════════════════════════════════════════════════════════

export function generateConfirmationThankYouEmail(params: {
  firstName: string
  appointmentType: string
  dateTime: string
  location?: string | null
  practiceName: string
}): { subject: string; html: string; text: string } {
  const { firstName, appointmentType, dateTime, location, practiceName } = params

  const subject = `✅ Confirmed! Your ${appointmentType} at ${practiceName}`

  const html = `
<div style="${emailStyles.container}">
  <div style="background: linear-gradient(135deg, #059669 0%, #10b981 100%); padding: 28px 24px; text-align: center;">
    <h1 style="${emailStyles.headerTitle}">You're All Set! ✅</h1>
    <p style="${emailStyles.headerSubtitle}">Your appointment is confirmed</p>
  </div>

  <div style="${emailStyles.body}">
    <p style="${emailStyles.greeting}">
      Thanks for confirming, ${firstName}!
    </p>
    <p style="font-size: 15px; color: #4b5563; line-height: 1.6; margin: 0 0 20px 0;">
      We've confirmed your appointment and everything is all set. Here's a final summary:
    </p>

    <div style="${emailStyles.detailCard}">
      <div style="padding: 8px 0;">
        <span style="${emailStyles.detailLabel}">📋 Type:</span>
        <span style="${emailStyles.detailValue}">${appointmentType.charAt(0).toUpperCase() + appointmentType.slice(1)}</span>
      </div>
      <div style="padding: 8px 0;">
        <span style="${emailStyles.detailLabel}">📅 Date & Time:</span>
        <span style="font-weight: 600; color: #059669; font-size: 15px;">${dateTime}</span>
      </div>
      ${location ? `
      <div style="padding: 8px 0;">
        <span style="${emailStyles.detailLabel}">📍 Location:</span>
        <span style="${emailStyles.detailValue}">${location}</span>
      </div>
      ` : ''}
      <div style="padding: 8px 0;">
        <span style="${emailStyles.detailLabel}">✅ Status:</span>
        <span style="color: #059669; font-weight: 600;">Confirmed</span>
      </div>
    </div>

    <p style="font-size: 14px; color: #4b5563; line-height: 1.6; margin: 0;">
      Remember to arrive <strong>15 minutes early</strong>. If anything changes, 
      please don't hesitate to reach out. We're here to help!
    </p>
  </div>

  <div style="${emailStyles.footer}">
    <p style="${emailStyles.footerText}">
      ${practiceName} — Looking forward to seeing you! 🎉
    </p>
  </div>
</div>`

  const text = `Hi ${firstName},

Thanks for confirming! Your ${appointmentType} at ${practiceName} is all set.

📅 ${dateTime}
${location ? `📍 ${location}` : ''}
✅ Status: Confirmed

Remember to arrive 15 minutes early.

— ${practiceName}`

  return { subject, html, text }
}

// ═══════════════════════════════════════════════════════════════
// SMS TEMPLATES
// ═══════════════════════════════════════════════════════════════

export function generate24hSmsTemplate(params: {
  firstName: string
  appointmentType: string
  dateTime: string
  practiceName: string
}): string {
  return `Hi ${params.firstName}! 👋 Friendly reminder: your ${params.appointmentType} at ${params.practiceName} is tomorrow, ${params.dateTime}. We're excited to see you! Reply YES to confirm or call us to reschedule.`
}

export function generate1hSmsTemplate(params: {
  firstName: string
  appointmentTime: string
  practiceName: string
}): string {
  return `Hi ${params.firstName}! Just a heads up — your appointment at ${params.practiceName} is in about 1 hour (${params.appointmentTime}). See you soon! 😊`
}

export function generateConfirmationSmsReply(params: {
  firstName: string
  dateTime: string
  practiceName: string
}): string {
  return `Thanks for confirming, ${params.firstName}! ✅ Your appointment at ${params.practiceName} on ${params.dateTime} is confirmed. See you then!`
}
