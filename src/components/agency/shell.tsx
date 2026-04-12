'use client'

import { useState } from 'react'
import { AgencySidebar, AgencyMobileSidebar } from '@/components/agency/sidebar'
import { AgencyTopbar } from '@/components/agency/topbar'

interface AgencyShellProps {
  children: React.ReactNode
  userProfile: {
    id: string
    full_name: string
    email: string
    role: string
  }
}

export function AgencyShell({ children, userProfile }: AgencyShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <div className="flex h-screen overflow-hidden bg-slate-950">
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
        <main className="flex-1 overflow-y-auto bg-slate-900/50 p-6">
          <div className="mx-auto max-w-7xl">
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}
