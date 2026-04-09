import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// TEMPORARY DEBUG ENDPOINT — Remove before production
// Confirms a user's email for local testing when no service role key is available
export async function POST(request: NextRequest) {
  const { email } = await request.json()

  if (!email) {
    return NextResponse.json({ error: 'email required' }, { status: 400 })
  }

  // Use service role key if available
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceKey) {
    return NextResponse.json({
      error: 'SUPABASE_SERVICE_ROLE_KEY not set. Go to Supabase Dashboard > Settings > API > service_role key and add it to .env.local',
      workaround: 'Alternatively, go to Supabase Dashboard > Authentication > Users, find the user, and click "Confirm email" manually'
    }, { status: 500 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey
  )

  // Use admin API to update user
  const { data: users } = await supabase.auth.admin.listUsers()
  const user = users?.users?.find(u => u.email === email)

  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase.auth.admin as any).updateUserById(user.id, {
    email_confirm: true,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    message: `Email confirmed for ${email}. You can now sign in.`,
    user_id: user.id
  })
}
