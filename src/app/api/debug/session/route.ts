import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(request: NextRequest) {
  const supabase = await createClient()

  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({
      step: 'auth',
      error: authError?.message || 'No user',
      cookies: request.cookies.getAll().map(c => c.name),
    })
  }

  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  if (profileError || !profile) {
    return NextResponse.json({
      step: 'profile',
      user_id: user.id,
      error: profileError?.message || 'No profile found',
    })
  }

  const { data: org, error: orgError } = await supabase
    .from('organizations')
    .select('*')
    .eq('id', profile.organization_id)
    .single()

  if (orgError || !org) {
    return NextResponse.json({
      step: 'organization',
      user_id: user.id,
      org_id: profile.organization_id,
      error: orgError?.message || 'No org found',
    })
  }

  return NextResponse.json({
    step: 'success',
    user_id: user.id,
    email: user.email,
    profile_name: profile.full_name,
    org_name: org.name,
    org_id: org.id,
  })
}
