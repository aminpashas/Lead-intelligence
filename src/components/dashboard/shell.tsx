'use client'

import { useEffect } from 'react'
import { Sidebar } from './sidebar'
import { Topbar } from './topbar'
import { useOrgStore } from '@/lib/store/use-org'
import type { Organization, UserProfile } from '@/types/database'
import { Toaster } from '@/components/ui/sonner'

export function DashboardShell({
  children,
  userProfile,
  organization,
}: {
  children: React.ReactNode
  userProfile: UserProfile
  organization: Organization
}) {
  const { setOrganization, setUserProfile } = useOrgStore()

  useEffect(() => {
    setOrganization(organization)
    setUserProfile(userProfile)
  }, [organization, userProfile, setOrganization, setUserProfile])

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar />
        <main className="flex-1 overflow-y-auto p-6">
          {children}
        </main>
      </div>
      <Toaster />
    </div>
  )
}
