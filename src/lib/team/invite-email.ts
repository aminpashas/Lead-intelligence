import type { ProvisionRole } from '@/lib/team/provision'

/** Human-facing labels for the six practice-team roles. */
const ROLE_LABELS: Record<ProvisionRole, string> = {
  doctor_admin: 'Doctor (Admin)',
  doctor: 'Doctor',
  nurse: 'Nurse',
  assistant: 'Assistant',
  treatment_coordinator: 'Treatment Coordinator',
  office_manager: 'Office Manager',
}

export interface InviteEmailInput {
  fullName: string
  organizationName: string
  inviterName?: string | null
  role: ProvisionRole
  acceptUrl: string
}

export interface BuiltEmail {
  subject: string
  html: string
  text: string
}

/**
 * Branded team-invitation email. Transactional (system) send — routed through
 * `sendEmail()`, which bypasses the lead-consent gate but still honors the
 * DRY-RUN and TEST_SEND_ALLOWLIST clamps.
 */
export function buildInviteEmail(input: InviteEmailInput): BuiltEmail {
  const roleLabel = ROLE_LABELS[input.role] ?? input.role
  const firstName = input.fullName.trim().split(/\s+/)[0] || 'there'
  const invitedBy = input.inviterName?.trim()
    ? `${input.inviterName.trim()} has invited you`
    : "You've been invited"

  const subject = `You're invited to ${input.organizationName} on Lead Intelligence`

  const html = `<!doctype html>
<html>
  <body style="margin:0;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c1917;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f4;padding:32px 16px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e7e5e4;border-radius:14px;overflow:hidden;">
          <tr><td style="padding:28px 32px 8px;">
            <p style="margin:0;font-size:11px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:#0f766e;">Lead Intelligence</p>
          </td></tr>
          <tr><td style="padding:8px 32px 0;">
            <h1 style="margin:0 0 12px;font-size:22px;line-height:1.25;color:#1c1917;">Hi ${escapeHtml(firstName)}, welcome aboard.</h1>
            <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#44403c;">
              ${escapeHtml(invitedBy)} to join <strong>${escapeHtml(input.organizationName)}</strong> as
              <strong>${escapeHtml(roleLabel)}</strong>. Set your password to activate your account and get started.
            </p>
          </td></tr>
          <tr><td style="padding:8px 32px 4px;">
            <a href="${input.acceptUrl}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 24px;border-radius:10px;">
              Accept invitation
            </a>
          </td></tr>
          <tr><td style="padding:16px 32px 28px;">
            <p style="margin:0;font-size:12.5px;line-height:1.6;color:#78716c;">
              If the button doesn't work, copy and paste this link into your browser:<br>
              <a href="${input.acceptUrl}" style="color:#0f766e;word-break:break-all;">${input.acceptUrl}</a>
            </p>
            <p style="margin:16px 0 0;font-size:12.5px;line-height:1.6;color:#a8a29e;">
              This invitation link is single-use and will expire. If you weren't expecting it, you can ignore this email.
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`

  const text = [
    `Hi ${firstName},`,
    ``,
    `${invitedBy} to join ${input.organizationName} as ${roleLabel} on Lead Intelligence.`,
    `Set your password to activate your account:`,
    ``,
    input.acceptUrl,
    ``,
    `This invitation link is single-use and will expire. If you weren't expecting it, you can ignore this email.`,
  ].join('\n')

  return { subject, html, text }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
