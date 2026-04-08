import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { DashboardShell } from '@/components/dashboard/shell'

export default async function DashboardLayout({
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

  // First get the user's own profile
  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  if (profileError || !profile) {
    console.error('Dashboard layout - profile fetch failed:', profileError?.message)
    console.error('User ID:', user.id)
    redirect('/login')
  }

  // Then get their organization separately
  const { data: organization, error: orgError } = await supabase
    .from('organizations')
    .select('*')
    .eq('id', profile.organization_id)
    .single()

  if (orgError || !organization) {
    console.error('Dashboard layout - org fetch failed:', orgError?.message)
    console.error('Org ID:', profile.organization_id)
    redirect('/login')
  }

  return (
    <DashboardShell
      userProfile={profile}
      organization={organization}
    >
      {children}
    </DashboardShell>
  )
}
