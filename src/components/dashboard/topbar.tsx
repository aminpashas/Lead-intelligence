'use client'

import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useOrgStore } from '@/lib/store/use-org'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Bell, Search, Menu } from 'lucide-react'
import { NewLeadDialog } from '@/components/crm/new-lead-dialog'
import { Input } from '@/components/ui/input'
import { ThemeToggle } from '@/components/ui/theme-toggle'

export function Topbar({ onMenuClick }: { onMenuClick?: () => void }) {
  const router = useRouter()
  const supabase = createClient()
  const { userProfile, organization } = useOrgStore()

  async function handleSignOut() {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  const initials = userProfile?.full_name
    ?.split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || 'U'

  return (
    <header className="flex h-16 items-center justify-between border-b bg-card px-4 lg:px-6">
      {/* Left: Hamburger + Search */}
      <div className="flex items-center gap-3 flex-1 max-w-md">
        {onMenuClick && (
          <Button variant="ghost" size="icon" className="lg:hidden h-9 w-9" onClick={onMenuClick}>
            <Menu className="h-5 w-5" />
          </Button>
        )}
        <div className="relative flex-1 hidden sm:block">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search leads, conversations..."
            className="pl-9"
          />
        </div>
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-2">
        <div className="hidden sm:block">
          <NewLeadDialog />
        </div>

        <ThemeToggle />

        <Button variant="ghost" size="icon" className="relative h-9 w-9">
          <Bell className="h-4 w-4" />
          <span className="absolute -top-0.5 -right-0.5 h-4 w-4 rounded-full bg-destructive text-[10px] font-bold text-destructive-foreground flex items-center justify-center">
            3
          </span>
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger>
            <span className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent cursor-pointer">
              <Avatar className="h-7 w-7">
                <AvatarFallback className="text-xs">{initials}</AvatarFallback>
              </Avatar>
              <span className="text-sm font-medium hidden md:inline">
                {userProfile?.full_name || 'User'}
              </span>
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <div className="px-2 py-1.5">
              <p className="text-sm font-medium">{userProfile?.full_name}</p>
              <p className="text-xs text-muted-foreground">{organization?.name}</p>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => router.push('/settings')}>
              Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleSignOut} className="text-destructive">
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
