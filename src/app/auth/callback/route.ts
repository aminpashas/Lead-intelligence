import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { postLoginPath } from '@/lib/auth/post-login-path'

// GET /auth/callback - Handle OAuth callback from Supabase (Google, etc.)
// After exchange, we read the user's role + active-practice selection and
// redirect via postLoginPath():
//   agency_admin with no active practice → /agency (Agency Console)
//   agency_admin who has entered a practice → /dashboard (resume that CRM)
//   all other roles → /dashboard
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

      // Otherwise check user role + active-practice selection for smart redirect
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('role')
          .eq('id', user.id)
          .single()

        // An agency_admin who has "entered" a practice (a row in
        // agency_active_org) should resume that practice's dashboard rather
        // than be sent back to the Agency Console. RLS scopes this to the
        // caller's own row; maybeSingle() tolerates "none entered".
        let actingAsClient = false
        if (profile?.role === 'agency_admin') {
          const { data: active } = await supabase
            .from('agency_active_org')
            .select('active_org_id')
            .maybeSingle()
          actingAsClient = !!active?.active_org_id
        }

        const destination = postLoginPath({ role: profile?.role, actingAsClient })
        return NextResponse.redirect(`${origin}${destination}`)
      }
    }
  }

  // Return to login with error if callback fails
  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`)
}
