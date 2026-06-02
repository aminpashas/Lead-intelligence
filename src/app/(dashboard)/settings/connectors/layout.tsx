import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

/**
 * Marketing connectors are agency-owned. Client staff must never reach this
 * section, so we hard-gate the whole /settings/connectors subtree to
 * agency_admin server-side (the sidebar link is already hidden for everyone
 * else via the connectors:manage permission, but the nav filter is only UX).
 *
 * The dashboard layout already redirects an agency_admin with no active client
 * to /agency, so by the time we're here an agency_admin is inside a client.
 */
export default async function ConnectorsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!profile || profile.role !== 'agency_admin') {
    redirect('/dashboard')
  }

  return <>{children}</>
}
