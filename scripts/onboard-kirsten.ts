/**
 * One-off: onboard Kirsten Smith as a treatment_coordinator in SF Dentistry via
 * the real invite flow (pending_team_invites stage -> admin.createUser ->
 * invite-aware signup trigger -> recovery link), then email her the one-time
 * set-password link directly via Resend.
 *
 *   npx tsx scripts/onboard-kirsten.ts
 *
 * treatment_coordinator is a deliberately limited role (src/lib/auth/permissions.ts,
 * TC_PERMISSIONS): NO bulk/mass outbound, NO ai_control (automation toggles), NO
 * team/settings/billing admin. She can work individual leads/pipeline, 1:1
 * conversations + call center, smart lists, read-only campaign/funnel/reactivation
 * visibility, and generate contracts.
 *
 * Sends the invite to ksmith@dionhealth.com ONLY (single authorized recipient;
 * bypasses the test-allowlist wrapper deliberately, mirroring send-heather-invite.ts).
 * Idempotent: aborts if the account already exists.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { Resend } from 'resend'

const ORG_ID = 'fa64e53c-3d9b-493e-b904-59580cb3f29c' // SF Dentistry
const ORG_NAME = 'SF Dentistry'
const INVITED_BY = '95334bb4-b877-4f05-80d2-be6c7d3633a6' // asamadian@dionhealth.com (agency_admin)
const INVITER = 'Dr Amin Samadian'
const EMAIL = 'ksmith@dionhealth.com'
const FULL_NAME = 'Kirsten Smith'
const FIRST = 'Kirsten'
const ROLE = 'treatment_coordinator'
const ROLE_LABEL = 'Treatment Coordinator'

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || 'https://lead-intelligence-jet.vercel.app').replace(/\/$/, '')

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

async function findUser(email: string) {
  const { data } = await service.auth.admin.listUsers({ page: 1, perPage: 1000 })
  return data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase()) || null
}

async function main() {
  const email = EMAIL.trim().toLowerCase()

  if (await findUser(email)) {
    console.log(`⚠️  ${email} already has an account — aborting (no double-create).`)
    return
  }

  // 1. Stage the invite so the signup trigger places her in SF Dentistry as TC.
  const { error: stageErr } = await service
    .from('pending_team_invites')
    .upsert({ email, organization_id: ORG_ID, role: ROLE, invited_by: INVITED_BY }, { onConflict: 'email' })
  if (stageErr) throw new Error(`stage failed: ${stageErr.message}`)

  // 2. Create the auth user (no password yet). Trigger inserts the profile.
  const { data: created, error: createErr } = await service.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: FULL_NAME },
  })
  if (createErr || !created?.user) {
    await service.from('pending_team_invites').delete().eq('email', email)
    throw new Error(createErr?.message || 'createUser failed')
  }
  const userId = created.user.id

  // 3. Confirm the trigger placed her correctly + mark active.
  const { data: profile, error: pErr } = await service
    .from('user_profiles')
    .update({ is_active: true })
    .eq('id', userId)
    .select('organization_id, role, full_name, email')
    .single()
  if (pErr || !profile) {
    await service.auth.admin.deleteUser(userId).catch(() => {})
    throw new Error(`profile update failed: ${pErr?.message}`)
  }
  if (profile.organization_id !== ORG_ID || profile.role !== ROLE) {
    await service.auth.admin.deleteUser(userId).catch(() => {})
    throw new Error(`trigger misplaced profile: org=${profile.organization_id} role=${profile.role}`)
  }

  // 4. Mint a one-time set-password link.
  const { data: linkData, error: linkErr } = await service.auth.admin.generateLink({
    type: 'recovery',
    email,
  })
  if (linkErr || !linkData?.properties?.hashed_token) throw new Error(linkErr?.message || 'no token')
  const acceptUrl = `${APP_URL}/accept-invite?token_hash=${encodeURIComponent(linkData.properties.hashed_token)}&type=recovery`

  console.log('\n✅ Kirsten Smith provisioned in SF Dentistry')
  console.log('   user id :', userId)
  console.log('   org     :', profile.organization_id, `(${ORG_NAME})`)
  console.log('   role    :', profile.role)

  // 5. Send the branded invite email directly to Kirsten (single recipient).
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
  const { data: sent, error: sendErr } = await resend.emails.send({
    from: fromAddr,
    to: email, // single authorized recipient
    subject,
    html,
    text,
  })
  if (sendErr) throw new Error(`Resend failed: ${sendErr.message}`)

  console.log('\n📧 Invite email sent to', email)
  console.log('   resend id:', sent?.id)
  console.log('   from     :', fromAddr)
  console.log('\n🔗 Link (also in the email; expires ~1h):\n   ' + acceptUrl + '\n')
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1) })
