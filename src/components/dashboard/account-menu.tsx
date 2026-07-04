'use client'

import type { ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useOrgStore } from '@/lib/store/use-org'
import { isAdminRole, ROLE_LABELS, ROLE_COLORS, type PracticeRole } from '@/lib/auth/permissions'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { UsersRound, LogOut, Settings } from 'lucide-react'
import { cn } from '@/lib/utils'

type Placement = {
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'bottom' | 'left' | 'right'
}

/**
 * The single account/profile menu, shared by the topbar avatar and the sidebar
 * footer card. Each surface supplies only its own trigger visual (`children`)
 * and placement; the item set, role gating, and actions live here so the two
 * surfaces can never drift apart. `onNavigate` lets the mobile sidebar close its
 * drawer as it routes.
 */
export function AccountMenu({
  children,
  triggerClassName,
  align = 'end',
  side = 'bottom',
  onNavigate,
}: Placement & {
  children: ReactNode
  triggerClassName?: string
  onNavigate?: () => void
}) {
  const router = useRouter()
  const supabase = createClient()
  const { userProfile, organization, actingAsClient } = useOrgStore()
  const role = (userProfile?.role || 'member') as PracticeRole

  function go(href: string) {
    onNavigate?.()
    router.push(href)
  }

  async function handleSignOut() {
    onNavigate?.()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  async function handleExitAccount() {
    onNavigate?.()
    await fetch('/api/agency/active-account', { method: 'DELETE' })
    router.push('/agency')
    router.refresh()
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={triggerClassName}>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} side={side} className="w-56">
        <div className="px-2 py-1.5">
          <p className="text-sm font-medium truncate">{userProfile?.full_name || 'User'}</p>
          {organization?.name && (
            <p className="text-xs text-muted-foreground truncate">{organization.name}</p>
          )}
          <Badge
            variant="outline"
            className={cn('text-[10px] px-1.5 py-0 h-4 font-medium mt-1', ROLE_COLORS[role])}
          >
            {ROLE_LABELS[role] || role}
          </Badge>
        </div>
        <DropdownMenuSeparator />
        {actingAsClient && (
          <>
            <DropdownMenuItem onClick={handleExitAccount} className="cursor-pointer">
              <LogOut className="mr-2 h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
              Exit to Agency Console
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {isAdminRole(role) && (
          <DropdownMenuItem onClick={() => go('/settings/team')} className="cursor-pointer">
            <UsersRound className="mr-2 h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
            Team Management
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => go('/settings')} className="cursor-pointer">
          <Settings className="mr-2 h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
          Settings
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={handleSignOut}
          variant="destructive"
          className="cursor-pointer"
        >
          <LogOut className="mr-2 h-4 w-4" strokeWidth={1.75} />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
