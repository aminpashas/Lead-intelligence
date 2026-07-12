import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { AgencyShell } from '@/components/agency/shell'
import { aureaFontVars } from '@/lib/fonts'
import { resolveAgencyLevel } from '@/lib/auth/permissions'

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
    .select('id, full_name, email, role, organization_id, agency_access_level')
    .eq('id', user.id)
    .single()

  if (error || !profile) {
    redirect('/login')
  }

  // Gate: only agency staff (role=agency_admin) can access /agency/* routes.
  const level = resolveAgencyLevel(profile.role, profile.agency_access_level)
  if (!level) {
    // Redirect practice users to their dashboard
    redirect('/dashboard')
  }

  return (
    <AgencyShell
      fontClassName={aureaFontVars}
      level={level}
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
