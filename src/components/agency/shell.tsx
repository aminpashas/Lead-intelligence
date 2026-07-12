'use client'

import { useState } from 'react'
import { AgencySidebar, AgencyMobileSidebar } from '@/components/agency/sidebar'
import { AgencyTopbar } from '@/components/agency/topbar'
import type { AgencyAccessLevel } from '@/lib/auth/permissions'

interface AgencyShellProps {
  children: React.ReactNode
  fontClassName?: string
  level: AgencyAccessLevel
  userProfile: {
    id: string
    full_name: string
    email: string
    role: string
  }
}

export function AgencyShell({ children, fontClassName, level, userProfile }: AgencyShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <div className={`aurea flex h-screen overflow-hidden bg-aurea-canvas ${fontClassName ?? ''}`}>
      {/* Desktop Sidebar */}
      <AgencySidebar level={level} />

      {/* Mobile Sidebar */}
      <AgencyMobileSidebar
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
        level={level}
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
