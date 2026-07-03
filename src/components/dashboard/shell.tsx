'use client'

import { useEffect, useState } from 'react'
import { Sidebar, MobileSidebar } from './sidebar'
import { Topbar } from './topbar'
import { useOrgStore } from '@/lib/store/use-org'
import type { Organization, UserProfile } from '@/types/database'
import { Toaster } from '@/components/ui/sonner'
import { useRealtimeNotifications } from '@/lib/hooks/use-realtime-notifications'
import { SoftphoneProvider } from '@/components/voice/softphone-provider'
import { Softphone } from '@/components/voice/softphone'

export function DashboardShell({
  children,
  fontClassName,
  userProfile,
  organization,
  actingAsClient = false,
}: {
  children: React.ReactNode
  fontClassName?: string
  userProfile: UserProfile
  organization: Organization
  actingAsClient?: boolean
}) {
  const { setOrganization, setUserProfile, setActingAsClient } = useOrgStore()
  const [sidebarOpen, setSidebarOpen] = useState(false)

  useEffect(() => {
    setOrganization(organization)
    setUserProfile(userProfile)
    setActingAsClient(actingAsClient)
  }, [organization, userProfile, actingAsClient, setOrganization, setUserProfile, setActingAsClient])

  // Real-time notifications (leads, messages, appointments, campaigns)
  useRealtimeNotifications()

  return (
    <SoftphoneProvider>
      <div className={`aurea flex h-screen overflow-hidden bg-aurea-canvas ${fontClassName ?? ''}`}>
        <Sidebar />
        <MobileSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <div className="flex flex-1 flex-col overflow-hidden">
          <Topbar onMenuClick={() => setSidebarOpen(true)} />
          <main className="aurea-floor flex-1 overflow-y-auto p-4 lg:p-6">
            {children}
          </main>
        </div>
        <Softphone />
        <Toaster />
      </div>
    </SoftphoneProvider>
  )
}
