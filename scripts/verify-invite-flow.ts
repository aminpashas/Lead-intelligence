/**
 * QA: verify the team-invite / accept-invite flow end-to-end WITHOUT touching a
 * real person. Mirrors `provisionMember` exactly (admin.createUser with
 * app_metadata → invite-aware trigger → recovery link), asserts the profile
 * landed in SF Dentistry with the right role and NO stray org was created, and
 * prints a localhost accept-invite URL carrying the real one-time token.
 *
 *   npx tsx scripts/verify-invite-flow.ts provision   # create + assert + print URL
 *   npx tsx scripts/verify-invite-flow.ts cleanup      # delete the test user
 *
 * Hard-safe: uses a non-routable `@sfdentistry.test` address and sends NO email.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'

const ORG_ID = 'fa64e53c-3d9b-493e-b904-59580cb3f29c' // SF Dentistry
const TEST_EMAIL = 'flowtest.invite@sfdentistry.test'
const TEST_NAME = 'Flow Test Invitee'
const TEST_ROLE = 'office_manager'
const LOCAL_BASE = 'http://localhost:3002'

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

async function findUser(email: string) {
  const { data } = await service.auth.admin.listUsers({ page: 1, perPage: 1000 })
  return data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase()) || null
}

async function provision() {
  const existing = await findUser(TEST_EMAIL)
  if (existing) {
    console.log('Test user already exists — cleaning up first.')
    await service.auth.admin.deleteUser(existing.id)
  }

  const orgsBefore = await countMyPracticeOrgs()

  // Stage the invite exactly like provisionMember does.
  const { error: stageErr } = await service
    .from('pending_team_invites')
    .upsert({ email: TEST_EMAIL, organization_id: ORG_ID, role: TEST_ROLE }, { onConflict: 'email' })
  if (stageErr) throw new Error(`stage failed: ${stageErr.message}`)

  const { data: created, error: createErr } = await service.auth.admin.createUser({
    email: TEST_EMAIL,
    email_confirm: true,
    user_metadata: { full_name: TEST_NAME },
  })
  if (createErr || !created?.user) throw new Error(createErr?.message || 'createUser failed')
  const userId = created.user.id

  // The trigger should have placed the profile directly in SF Dentistry.
  const { data: profile, error: pErr } = await service
    .from('user_profiles')
    .select('organization_id, role, email')
    .eq('id', userId)
    .single()
  if (pErr || !profile) throw new Error(`no profile after createUser: ${pErr?.message}`)

  const orgsAfter = await countMyPracticeOrgs()

  // Assertions
  const okOrg = profile.organization_id === ORG_ID
  const okRole = profile.role === TEST_ROLE
  const okNoStray = orgsAfter === orgsBefore
  console.log('ASSERT profile in SF Dentistry:', okOrg ? 'PASS' : `FAIL (${profile.organization_id})`)
  console.log('ASSERT role =', TEST_ROLE + ':', okRole ? 'PASS' : `FAIL (${profile.role})`)
  console.log('ASSERT no stray "My Practice" org created:', okNoStray ? 'PASS' : `FAIL (${orgsBefore}→${orgsAfter})`)
  if (!okOrg || !okRole || !okNoStray) {
    await service.auth.admin.deleteUser(userId).catch(() => {})
    throw new Error('Assertions failed — rolled back test user.')
  }

  const { data: linkData, error: linkErr } = await service.auth.admin.generateLink({
    type: 'recovery',
    email: TEST_EMAIL,
  })
  if (linkErr || !linkData?.properties?.hashed_token) throw new Error(linkErr?.message || 'no token')

  const url = `${LOCAL_BASE}/accept-invite?token_hash=${encodeURIComponent(linkData.properties.hashed_token)}&type=recovery`
  console.log('\n✅ Provisioned test invitee.')
  console.log('   user id:', userId)
  console.log('   ACCEPT URL:\n   ' + url + '\n')
}

async function countMyPracticeOrgs(): Promise<number> {
  const { count } = await service
    .from('organizations')
    .select('id', { count: 'exact', head: true })
    .eq('name', 'My Practice')
  return count ?? -1
}

async function cleanup() {
  const u = await findUser(TEST_EMAIL)
  if (!u) {
    console.log('No test user to clean up.')
    return
  }
  await service.auth.admin.deleteUser(u.id) // cascades user_profiles row
  console.log('🧹 Deleted test user', u.id)
}

const action = process.argv[2]
;(action === 'cleanup' ? cleanup() : provision()).catch((e) => {
  console.error('ERROR:', e.message)
  process.exit(1)
})
