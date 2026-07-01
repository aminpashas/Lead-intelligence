'use client'

import { useState } from 'react'
import { AgencySidebar, AgencyMobileSidebar } from '@/components/agency/sidebar'
import { AgencyTopbar } from '@/components/agency/topbar'

interface AgencyShellProps {
  children: React.ReactNode
  fontClassName?: string
  userProfile: {
    id: string
    full_name: string
    email: string
    role: string
  }
}

export function AgencyShell({ children, fontClassName, userProfile }: AgencyShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <div className={`aurea flex h-screen overflow-hidden bg-aurea-canvas ${fontClassName ?? ''}`}>
      {/* Desktop Sidebar */}
      <AgencySidebar />

      {/* Mobile Sidebar */}
      <AgencyMobileSidebar
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
      />

      {/* Main Content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <AgencyTopbar
          userProfile={userProfile}
          onMenuClick={() => setMobileOpen(true)}
        />
        <main className="aurea-floor flex-1 overflow-y-auto px-5 py-7 sm:px-8 sm:py-9">
          <div className="mx-auto max-w-7xl">
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}
