import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { DashboardShell } from '@/components/dashboard/shell'
import { aureaFontVars } from '@/lib/fonts'

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

  // Resolve the effective organization. An agency_admin who has "entered" a
  // client account (a row in agency_active_org) operates the whole dashboard as
  // that client; the same selection drives get_user_org_id() at the DB layer so
  // RLS-scoped queries return the client's data. An agency_admin with NO active
  // account has nothing to manage here — bounce them to the Agency Console
  // (which lives outside this route group, so there's no redirect loop).
  let effectiveOrgId = profile.organization_id
  let actingAsClient = false

  if (profile.role === 'agency_admin') {
    const { data: active } = await supabase
      .from('agency_active_org')
      .select('active_org_id')
      .maybeSingle()

    if (active?.active_org_id) {
      effectiveOrgId = active.active_org_id
      actingAsClient = true
    } else {
      redirect('/agency')
    }
  }

  // Then get the effective organization separately
  const { data: organization, error: orgError } = await supabase
    .from('organizations')
    .select('*')
    .eq('id', effectiveOrgId)
    .single()

  if (orgError || !organization) {
    console.error('Dashboard layout - org fetch failed:', orgError?.message)
    console.error('Org ID:', effectiveOrgId)
    redirect('/login')
  }

  return (
    <DashboardShell
      fontClassName={aureaFontVars}
      userProfile={profile}
      organization={organization}
      actingAsClient={actingAsClient}
    >
      {children}
    </DashboardShell>
  )
}
