'use client'

import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useOrgStore } from '@/lib/store/use-org'
import { isAdminRole, ROLE_LABELS, ROLE_COLORS, type PracticeRole } from '@/lib/auth/permissions'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Search, Menu, UsersRound, Building2, LogOut } from 'lucide-react'
import { NewLeadDialog } from '@/components/crm/new-lead-dialog'
import { Input } from '@/components/ui/input'
import { ThemeToggle } from '@/components/ui/theme-toggle'
import { NotificationDropdown } from './notification-dropdown'
import { cn } from '@/lib/utils'

export function Topbar({ onMenuClick }: { onMenuClick?: () => void }) {
  const router = useRouter()
  const supabase = createClient()
  const { userProfile, organization, actingAsClient } = useOrgStore()
  const role = (userProfile?.role || 'member') as PracticeRole

  async function handleSignOut() {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
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
        <div className="relative flex-1 hidden sm:block">
          <Search className="absolute left-3 top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-aurea-ink-3" strokeWidth={1.75} />
          <Input
            placeholder="Search leads, conversations..."
            className="pl-9 bg-aurea-surface border-aurea-border text-aurea-ink placeholder:text-aurea-ink-3 focus-visible:ring-aurea-primary/30"
          />
        </div>
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

        <div className="hidden sm:block">
          <NewLeadDialog />
        </div>

        <ThemeToggle />

        <NotificationDropdown />

        <DropdownMenu>
          <DropdownMenuTrigger>
            <span className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-aurea-surface-2 cursor-pointer transition-colors">
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
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-56 bg-aurea-surface border-aurea-border text-aurea-ink-2"
          >
            <div className="px-2 py-1.5">
              <p className="text-sm font-medium text-aurea-ink">{userProfile?.full_name}</p>
              <p className="text-xs text-aurea-ink-3">{organization?.name}</p>
              <Badge
                variant="outline"
                className={cn('text-[10px] px-1.5 py-0 h-4 font-medium mt-1 border-aurea-border', ROLE_COLORS[role])}
              >
                {ROLE_LABELS[role] || role}
              </Badge>
            </div>
            <DropdownMenuSeparator className="bg-aurea-border" />
            {actingAsClient && (
              <>
                <DropdownMenuItem
                  onClick={handleExitAccount}
                  className="text-aurea-ink-2 focus:bg-aurea-surface-2 focus:text-aurea-ink cursor-pointer"
                >
                  <LogOut className="mr-2 h-4 w-4 text-aurea-ink-3" strokeWidth={1.75} />
                  Exit to Agency Console
                </DropdownMenuItem>
                <DropdownMenuSeparator className="bg-aurea-border" />
              </>
            )}
            {isAdminRole(role) && (
              <DropdownMenuItem
                onClick={() => router.push('/settings/team')}
                className="text-aurea-ink-2 focus:bg-aurea-surface-2 focus:text-aurea-ink cursor-pointer"
              >
                <UsersRound className="mr-2 h-4 w-4 text-aurea-ink-3" strokeWidth={1.75} />
                Team Management
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={() => router.push('/settings')}
              className="text-aurea-ink-2 focus:bg-aurea-surface-2 focus:text-aurea-ink cursor-pointer"
            >
              Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-aurea-border" />
            <DropdownMenuItem
              onClick={handleSignOut}
              className="text-aurea-rose focus:bg-aurea-rose/10 focus:text-aurea-rose cursor-pointer"
            >
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
