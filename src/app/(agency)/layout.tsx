import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { AgencyShell } from '@/components/agency/shell'

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
