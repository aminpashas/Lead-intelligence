'use client'

import { useEffect, useState } from 'react'
import { Sidebar, MobileSidebar } from './sidebar'
import { Topbar } from './topbar'
import { useOrgStore } from '@/lib/store/use-org'
import type { Organization, UserProfile } from '@/types/database'
import { Toaster } from '@/components/ui/sonner'
import { useRealtimeLeads, useRealtimeConversations } from '@/lib/hooks/use-realtime-leads'

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
  const [sidebarOpen, setSidebarOpen] = useState(false)

  useEffect(() => {
    setOrganization(organization)
    setUserProfile(userProfile)
  }, [organization, userProfile, setOrganization, setUserProfile])

  // Real-time subscriptions
  useRealtimeLeads()
  useRealtimeConversations()

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <MobileSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar onMenuClick={() => setSidebarOpen(true)} />
        <main className="flex-1 overflow-y-auto p-4 lg:p-6">
          {children}
        </main>
      </div>
      <Toaster />
    </div>
  )
}
