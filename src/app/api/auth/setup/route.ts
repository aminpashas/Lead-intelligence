import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'

/**
 * POST /api/auth/setup — first-run org + owner-profile bootstrap.
 *
 * SECURITY: This route uses the service client (RLS bypass) to create an
 * organization and an `owner` user_profiles row. It MUST therefore be locked to
 * the authenticated caller:
 *   - a valid session is required (401 otherwise),
 *   - the profile is always created for the SESSION user id — the request body
 *     can no longer name an arbitrary `user_id` (previously this let anyone on
 *     the internet mint an `owner` profile for any auth.users id and spawn
 *     unlimited orgs),
 *   - it refuses to run if the caller already has a profile (no re-bootstrap /
 *     org takeover).
 *
 * In normal signup, org+profile are created by the `on_auth_user_created` DB
 * trigger; this endpoint is a fallback for accounts that predate the trigger.
 */
export async function POST(request: NextRequest) {
  const authed = await createClient()
  const { data: { user }, error: authError } = await authed.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const { full_name, practice_name } = body ?? {}
  // Identity is taken from the session, never the body.
  const user_id = user.id
  const email = user.email

  if (!full_name || !practice_name || !email) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  const supabase = createServiceClient()

  // Idempotency / anti-takeover: if this user already has a profile, do not
  // create a second org or overwrite their role.
  const { data: existingProfile } = await supabase
    .from('user_profiles')
    .select('id, organization_id')
    .eq('id', user_id)
    .maybeSingle()

  if (existingProfile) {
    return NextResponse.json({ error: 'Account already set up' }, { status: 409 })
  }

  // Create organization
  const slug = practice_name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

  const { data: org, error: orgError } = await supabase
    .from('organizations')
    .insert({
      name: practice_name,
      slug: `${slug}-${Date.now().toString(36)}`,
      email,
    })
    .select()
    .single()

  if (orgError) {
    console.error('[auth/setup] org create failed:', orgError)
    return NextResponse.json({ error: 'Failed to create organization' }, { status: 500 })
  }

  // Create user profile for the SESSION user
  const { error: profileError } = await supabase
    .from('user_profiles')
    .insert({
      id: user_id,
      organization_id: org.id,
      full_name,
      email,
      role: 'owner',
    })

  if (profileError) {
    console.error('[auth/setup] profile create failed:', profileError)
    return NextResponse.json({ error: 'Failed to create profile' }, { status: 500 })
  }

  return NextResponse.json({ organization: org })
}
