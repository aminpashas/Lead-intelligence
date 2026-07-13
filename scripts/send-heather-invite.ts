/**
 * One-off: email Heather Hawes her SF Dentistry set-password link.
 * Regenerates a fresh recovery link and sends a branded invite directly via
 * Resend to hhawes@dionhealth.com ONLY (authorized single recipient; bypasses
 * the test-allowlist wrapper deliberately). Account is already provisioned.
 *
 *   npx tsx scripts/send-heather-invite.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { Resend } from 'resend'

const EMAIL = 'hhawes@dionhealth.com'
const FIRST = 'Heather'
const ORG_NAME = 'SF Dentistry'
const ROLE_LABEL = 'Office Manager'
const INVITER = 'Dr Amin Samadian'
const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || 'https://lead-intelligence-jet.vercel.app').replace(/\/$/, '')

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

async function main() {
  const { data: linkData, error: linkErr } = await service.auth.admin.generateLink({
    type: 'recovery',
    email: EMAIL,
  })
  if (linkErr || !linkData?.properties?.hashed_token) throw new Error(linkErr?.message || 'no token')
  const acceptUrl = `${APP_URL}/accept-invite?token_hash=${encodeURIComponent(linkData.properties.hashed_token)}&type=recovery`

  const subject = `You're invited to ${ORG_NAME} on Lead Intelligence`
  const html = `<!doctype html><html><body style="margin:0;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c1917;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f4;padding:32px 16px;"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border:1px solid #e7e5e4;border-radius:14px;overflow:hidden;">
      <tr><td style="padding:28px 32px 8px;"><p style="margin:0;font-size:11px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:#0f766e;">Lead Intelligence</p></td></tr>
      <tr><td style="padding:8px 32px 0;">
        <h1 style="margin:0 0 12px;font-size:22px;line-height:1.25;">Hi ${FIRST}, welcome aboard.</h1>
        <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#44403c;">${INVITER} has invited you to join <strong>${ORG_NAME}</strong> as <strong>${ROLE_LABEL}</strong>. Set your password to activate your account.</p>
      </td></tr>
      <tr><td style="padding:8px 32px 4px;"><a href="${acceptUrl}" style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 24px;border-radius:10px;">Accept invitation</a></td></tr>
      <tr><td style="padding:16px 32px 28px;">
        <p style="margin:0;font-size:12.5px;line-height:1.6;color:#78716c;">If the button doesn't work, paste this link into your browser:<br><a href="${acceptUrl}" style="color:#0f766e;word-break:break-all;">${acceptUrl}</a></p>
        <p style="margin:16px 0 0;font-size:12.5px;line-height:1.6;color:#a8a29e;">This link is single-use and expires shortly. If you weren't expecting it, you can ignore this email.</p>
      </td></tr>
    </table>
  </td></tr></table></body></html>`
  const text = `Hi ${FIRST},\n\n${INVITER} has invited you to join ${ORG_NAME} as ${ROLE_LABEL} on Lead Intelligence. Set your password to activate your account:\n\n${acceptUrl}\n\nThis link is single-use and expires shortly.`

  const resend = new Resend(process.env.RESEND_API_KEY!)
  const fromAddr = process.env.TRANSACTIONAL_FROM_EMAIL?.trim() || process.env.RESEND_FROM_EMAIL!
  const { data, error } = await resend.emails.send({
    from: fromAddr,
    to: EMAIL, // single authorized recipient
    subject,
    html,
    text,
  })
  if (error) throw new Error(`Resend failed: ${error.message}`)
  console.log('\n✅ Invite email sent to', EMAIL)
  console.log('   resend id:', data?.id)
  console.log('   from     :', fromAddr)
  console.log('   link     :', acceptUrl)
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1) })
