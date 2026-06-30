import { redirect } from 'next/navigation'
import { Inter, Manrope, Instrument_Serif } from 'next/font/google'
import { createClient } from '@/lib/supabase/server'
import { AgencyShell } from '@/components/agency/shell'

// Aurea Health's real type system, scoped to the agency area: Instrument
// Serif for editorial display, Inter + Manrope for UI text.
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' })
const manrope = Manrope({ subsets: ['latin'], variable: '--font-manrope', display: 'swap' })
const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  variable: '--font-instrument-serif',
  display: 'swap',
})

export default async function AgencyLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  // Fetch user profile and verify agency_admin role
  const { data: profile, error } = await supabase
    .from('user_profiles')
    .select('id, full_name, email, role, organization_id')
    .eq('id', user.id)
    .single()

  if (error || !profile) {
    redirect('/login')
  }

  // Gate: only agency_admin can access /agency/* routes
  if (profile.role !== 'agency_admin') {
    // Redirect practice users to their dashboard
    redirect('/dashboard')
  }

  return (
    <AgencyShell
      fontClassName={`${inter.variable} ${manrope.variable} ${instrumentSerif.variable}`}
      userProfile={{
        id: profile.id,
        full_name: profile.full_name,
        email: profile.email,
        role: profile.role,
      }}
    >
      {children}
    </AgencyShell>
  )
}
