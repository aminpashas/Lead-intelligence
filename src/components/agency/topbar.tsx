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
import { Badge } from '@/components/ui/badge'
import {
  Menu,
  Zap,
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
    <header className="flex h-14 items-center justify-between border-b border-slate-800 bg-slate-950 px-4 shrink-0">
      {/* Left — mobile menu + breadcrumb */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden h-8 w-8 text-slate-400 hover:text-white hover:bg-slate-800"
          onClick={onMenuClick}
        >
          <Menu className="h-4 w-4" />
        </Button>

        <div className="hidden lg:flex items-center gap-2">
          <Zap className="h-4 w-4 text-violet-400" />
          <span className="text-sm font-medium text-slate-300">Agency Control Panel</span>
        </div>
      </div>

      {/* Right — status + user menu */}
      <div className="flex items-center gap-3">
        {/* Live status badge */}
        <div className="hidden sm:flex items-center gap-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 px-3 py-1">
          <div className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-[11px] font-medium text-emerald-400">Platform Online</span>
        </div>

        {/* User dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger
            className="flex items-center gap-2 h-9 px-3 text-slate-300 hover:text-white hover:bg-slate-800 rounded-xl transition-colors cursor-pointer border-0 bg-transparent"
          >
            <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center text-xs font-bold text-white shadow-sm">
              {initials}
            </div>
            <div className="hidden sm:block text-left">
              <p className="text-xs font-medium leading-none">{userProfile.full_name}</p>
              <Badge className="mt-0.5 h-3.5 text-[9px] px-1 bg-violet-500/20 text-violet-300 border-violet-500/30 border font-semibold tracking-wide">
                AGENCY
              </Badge>
            </div>
            <ChevronDown className="h-3 w-3 text-slate-500" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-56 bg-slate-900 border-slate-800 text-slate-200"
          >
            <DropdownMenuLabel className="text-xs text-slate-500">
              {userProfile.email}
            </DropdownMenuLabel>
            <DropdownMenuSeparator className="bg-slate-800" />
            <DropdownMenuItem
              className="hover:bg-slate-800 cursor-pointer"
              onClick={() => router.push('/agency/settings')}
            >
              <User className="mr-2 h-4 w-4 text-slate-400" />
              Agency Settings
            </DropdownMenuItem>
            <DropdownMenuItem
              className="hover:bg-slate-800 cursor-pointer"
              onClick={() => router.push('/dashboard')}
            >
              <LayoutDashboard className="mr-2 h-4 w-4 text-slate-400" />
              Switch to Practice View
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-slate-800" />
            <DropdownMenuItem
              className="hover:bg-red-950/50 text-red-400 cursor-pointer"
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
