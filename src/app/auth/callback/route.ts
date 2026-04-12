import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// GET /auth/callback - Handle OAuth callback from Supabase (Google, etc.)
// After exchange, we read the user's role and redirect:
//   agency_admin → /agency
//   all others   → /dashboard
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') // explicit override if provided

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)

    if (!error) {
      // If an explicit `next` param was provided, honour it
      if (next) {
        return NextResponse.redirect(`${origin}${next}`)
      }

      // Otherwise check user role for smart redirect
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('role')
          .eq('id', user.id)
          .single()

        const destination = profile?.role === 'agency_admin' ? '/agency' : '/dashboard'
        return NextResponse.redirect(`${origin}${destination}`)
      }
    }
  }

  // Return to login with error if callback fails
  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`)
}
