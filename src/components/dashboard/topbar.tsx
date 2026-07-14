'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useOrgStore } from '@/lib/store/use-org'
import { ROLE_LABELS, ROLE_COLORS, isFocusedStaff, type PracticeRole } from '@/lib/auth/permissions'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Search, Menu, Building2, LogOut } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { ThemeToggle } from '@/components/ui/theme-toggle'
import { NotificationDropdown } from './notification-dropdown'
import { AccountMenu } from './account-menu'
import { cn } from '@/lib/utils'

export function Topbar({ onMenuClick }: { onMenuClick?: () => void }) {
  const router = useRouter()
  const { userProfile, organization, actingAsClient } = useOrgStore()
  const role = (userProfile?.role || 'member') as PracticeRole
  const [search, setSearch] = useState('')

  function handleSearch() {
    const q = search.trim()
    if (!q) return
    // Reuse the existing server-side leads search (?search=) rather than a
    // second lookup path — see leads/page.tsx.
    router.push(`/leads?search=${encodeURIComponent(q)}`)
  }

  async function handleExitAccount() {
    await fetch('/api/agency/active-account', { method: 'DELETE' })
    router.push('/agency')
    router.refresh()
  }

  const initials = userProfile?.full_name
    ?.split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || 'U'

  return (
    <header className="aurea-topbar flex h-16 items-center justify-between border-b px-4 lg:px-6 shrink-0">
      {/* Left: Hamburger + Search */}
      <div className="flex items-center gap-3 flex-1 max-w-md">
        {onMenuClick && (
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden h-9 w-9 text-aurea-ink-2 hover:text-aurea-ink hover:bg-aurea-surface-2"
            onClick={onMenuClick}
          >
            <Menu className="h-5 w-5" strokeWidth={1.75} />
          </Button>
        )}
        {/* Search pushes into /leads?search= — focused clinical staff are
            server-redirected off /leads, so for them it silently dead-ends.
            Hide it rather than offer a broken entry point. */}
        {!isFocusedStaff(role) && (
          <div className="relative flex-1 hidden sm:block">
            <Search className="absolute left-3 top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-aurea-ink-3" strokeWidth={1.75} />
            <Input
              placeholder="Search leads by name, email, or phone..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              className="pl-9 bg-aurea-surface border-aurea-border text-aurea-ink placeholder:text-aurea-ink-3 focus-visible:ring-aurea-primary/30"
            />
          </div>
        )}
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-2">
        {actingAsClient && (
          <div className="hidden md:flex items-center gap-2 rounded-md border border-aurea-primary/30 bg-aurea-primary/5 px-2.5 py-1">
            <Building2 className="h-3.5 w-3.5 text-aurea-primary" strokeWidth={1.75} />
            <span className="text-xs">
              <span className="text-aurea-ink-3">Managing</span>{' '}
              <span className="font-medium text-aurea-ink">{organization?.name}</span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs text-aurea-ink-3 hover:text-aurea-ink"
              onClick={handleExitAccount}
            >
              <LogOut className="h-3 w-3 mr-1" strokeWidth={1.75} />
              Exit
            </Button>
          </div>
        )}

        <ThemeToggle />

        <NotificationDropdown />

        <AccountMenu
          align="end"
          triggerClassName="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-aurea-surface-2 cursor-pointer transition-colors"
        >
          <Avatar className="h-7 w-7 ring-1 ring-aurea-border">
            <AvatarFallback className="text-xs bg-aurea-surface-2 text-aurea-ink font-semibold">{initials}</AvatarFallback>
          </Avatar>
          <span className="text-[13px] font-medium text-aurea-ink hidden md:inline">
            {userProfile?.full_name || 'User'}
          </span>
          <Badge
            variant="outline"
            className={cn('text-[10px] px-1.5 py-0 h-4 font-medium hidden lg:inline-flex border-aurea-border', ROLE_COLORS[role])}
          >
            {ROLE_LABELS[role] || role}
          </Badge>
        </AccountMenu>
      </div>
    </header>
  )
}
