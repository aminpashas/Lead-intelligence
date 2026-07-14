'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Menu,
  LogOut,
  User,
  LayoutDashboard,
  ChevronDown,
} from 'lucide-react'

interface AgencyTopbarProps {
  userProfile: {
    id: string
    full_name: string
    email: string
    role: string
  }
  onMenuClick: () => void
}

export function AgencyTopbar({ userProfile, onMenuClick }: AgencyTopbarProps) {
  const router = useRouter()
  const supabase = createClient()
  const [loggingOut, setLoggingOut] = useState(false)

  async function handleLogout() {
    setLoggingOut(true)
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  const initials = userProfile.full_name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)

  return (
    <header className="aurea-topbar flex h-16 items-center justify-between border-b px-4 sm:px-6 shrink-0">
      {/* Left — mobile menu + breadcrumb */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Open navigation menu"
          className="lg:hidden h-8 w-8 text-aurea-ink-2 hover:text-aurea-ink hover:bg-aurea-surface-2"
          onClick={onMenuClick}
        >
          <Menu className="h-4 w-4" />
        </Button>

        <nav className="hidden lg:flex items-baseline gap-2.5">
          <span className="text-[13px] font-medium tracking-tight text-aurea-ink">Aurea Console</span>
          <span className="aurea-eyebrow">Agency</span>
        </nav>
      </div>

      {/* Right — status + user menu */}
      <div className="flex items-center gap-3 sm:gap-5">
        {/* Live status */}
        <div className="hidden sm:flex items-center gap-2">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-aurea-primary opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-aurea-primary" />
          </span>
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-aurea-ink-3">
            Platform Online
          </span>
        </div>

        {/* User dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-2.5 h-11 pl-1 pr-2 rounded-lg text-aurea-ink hover:bg-aurea-surface-2 transition-colors cursor-pointer border-0 bg-transparent">
            <div className="relative shrink-0">
              <div className="h-9 w-9 rounded-full bg-aurea-surface-2 ring-1 ring-aurea-border flex items-center justify-center text-[12px] font-semibold text-aurea-ink">
                {initials}
              </div>
              <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-aurea-primary ring-2 ring-aurea-canvas" />
            </div>
            <div className="hidden sm:block text-left leading-tight">
              <p className="text-[13px] font-semibold text-aurea-ink">{userProfile.full_name}</p>
              <p className="aurea-eyebrow">Agency Admin</p>
            </div>
            <ChevronDown className="h-3.5 w-3.5 text-aurea-ink-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-60 rounded-lg bg-aurea-surface border-aurea-border text-aurea-ink-2"
          >
            <DropdownMenuLabel className="text-[11px] font-normal text-aurea-ink-3 truncate">
              {userProfile.email}
            </DropdownMenuLabel>
            <DropdownMenuSeparator className="bg-aurea-border" />
            <DropdownMenuItem
              className="rounded-md text-aurea-ink-2 focus:bg-aurea-surface-2 focus:text-aurea-ink cursor-pointer"
              onClick={() => router.push('/agency/settings')}
            >
              <User className="mr-2 h-4 w-4 text-aurea-ink-3" />
              Agency Settings
            </DropdownMenuItem>
            <DropdownMenuItem
              className="rounded-md text-aurea-ink-2 focus:bg-aurea-surface-2 focus:text-aurea-ink cursor-pointer"
              onClick={() => router.push('/dashboard')}
            >
              <LayoutDashboard className="mr-2 h-4 w-4 text-aurea-ink-3" />
              Switch to Practice View
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-aurea-border" />
            <DropdownMenuItem
              className="rounded-md text-aurea-rose focus:bg-aurea-rose-soft focus:text-aurea-rose cursor-pointer"
              onClick={handleLogout}
              disabled={loggingOut}
            >
              <LogOut className="mr-2 h-4 w-4" />
              {loggingOut ? 'Signing out...' : 'Sign Out'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
