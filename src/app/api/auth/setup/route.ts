import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'

export async function POST(request: NextRequest) {
  const body = await request.json()
  const { user_id, full_name, email, practice_name } = body

  if (!user_id || !full_name || !email || !practice_name) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  const supabase = createServiceClient()

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
    return NextResponse.json({ error: orgError.message }, { status: 500 })
  }

  // Create user profile
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
    return NextResponse.json({ error: profileError.message }, { status: 500 })
  }

  return NextResponse.json({ organization: org })
}
