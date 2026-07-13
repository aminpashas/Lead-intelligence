/**
 * One-off: onboard Heather Hawes as an office_manager in SF Dentistry using the
 * real invite flow (pending_team_invites stage -> admin.createUser -> invite-aware
 * trigger -> recovery link). Prints the production accept-invite link to deliver.
 *
 *   npx tsx scripts/onboard-heather.ts
 *
 * Does NOT send email (the local TEST_SEND_ALLOWLIST would block hhawes@ anyway);
 * the prod Settings->Team UI sends the Resend email. This script just provisions
 * the account and mints the link.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'

const ORG_ID = 'fa64e53c-3d9b-493e-b904-59580cb3f29c' // SF Dentistry
const INVITED_BY = '95334bb4-b877-4f05-80d2-be6c7d3633a6' // Dr Amin Samadian (agency_admin)
const EMAIL = 'hhawes@dionhealth.com'
const FULL_NAME = 'Heather Hawes'
const ROLE = 'office_manager'
const PHONE = '+18058889879' // Heather's cell (from live-transfer setup)

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

  const { error: stageErr } = await service
    .from('pending_team_invites')
    .upsert({ email, organization_id: ORG_ID, role: ROLE, invited_by: INVITED_BY }, { onConflict: 'email' })
  if (stageErr) throw new Error(`stage failed: ${stageErr.message}`)

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

  const { data: profile, error: pErr } = await service
    .from('user_profiles')
    .update({ phone: PHONE, is_active: true })
    .eq('id', userId)
    .select('organization_id, role, full_name, email')
    .single()
  if (pErr || !profile) {
    await service.auth.admin.deleteUser(userId).catch(() => {})
    throw new Error(`profile update failed: ${pErr?.message}`)
  }

  const { data: linkData, error: linkErr } = await service.auth.admin.generateLink({
    type: 'recovery',
    email,
  })
  if (linkErr || !linkData?.properties?.hashed_token) {
    throw new Error(linkErr?.message || 'no token')
  }

  const url = `${APP_URL}/accept-invite?token_hash=${encodeURIComponent(linkData.properties.hashed_token)}&type=recovery`

  console.log('\n✅ Heather Hawes onboarded to SF Dentistry')
  console.log('   user id :', userId)
  console.log('   org     :', profile.organization_id, '(SF Dentistry)')
  console.log('   role    :', profile.role)
  console.log('   phone   :', PHONE)
  console.log('\n🔗 One-time set-password link (send to Heather):\n   ' + url + '\n')
  console.log('   Note: recovery links expire (~1h). Re-run to mint a fresh one if needed.')
}

main().catch((e) => {
  console.error('ERROR:', e.message)
  process.exit(1)
})
