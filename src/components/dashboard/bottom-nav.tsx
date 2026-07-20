'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { useOrgStore } from '@/lib/store/use-org'
import { canAccessRoute, isFocusedStaff, type PracticeRole } from '@/lib/auth/permissions'
import {
  LayoutDashboard,
  Users,
  MessageSquare,
  Calendar,
  ListTodo,
  Phone,
  type LucideIcon,
} from 'lucide-react'
import { useOpenTaskCount } from './sidebar'

type BottomNavItem = {
  name: string
  href: string
  icon: LucideIcon
}

// The five highest-traffic staff destinations. Everything else stays reachable
// through the hamburger drawer — this bar exists so the daily loop (inbox,
// leads, tasks, schedule) is one tap instead of two.
const BOTTOM_NAV_ITEMS: BottomNavItem[] = [
  { name: 'Home', href: '/dashboard', icon: LayoutDashboard },
  { name: 'Inbox', href: '/conversations', icon: MessageSquare },
  { name: 'Leads', href: '/leads', icon: Users },
  { name: 'Tasks', href: '/tasks', icon: ListTodo },
  { name: 'Calendar', href: '/appointments', icon: Calendar },
]

// Focused (clinical) staff are server-redirected off /leads — give them the
// call center slot instead so the bar never dead-ends (mirrors
// FOCUSED_STAFF_HIDDEN_HREFS in sidebar.tsx).
const FOCUSED_STAFF_SUBSTITUTE: BottomNavItem = { name: 'Calls', href: '/call-center', icon: Phone }

export function BottomNav() {
  const pathname = usePathname()
  const { userProfile } = useOrgStore()
  const role = (userProfile?.role || 'member') as PracticeRole
  const openTaskCount = useOpenTaskCount()

  const focused = isFocusedStaff(role)
  const items = BOTTOM_NAV_ITEMS.map((item) =>
    focused && item.href === '/leads' ? FOCUSED_STAFF_SUBSTITUTE : item
  ).filter((item) => canAccessRoute(role, item.href))

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/')

  return (
    <nav
      aria-label="Primary"
      className="lg:hidden shrink-0 border-t border-aurea-border bg-card pb-[env(safe-area-inset-bottom)]"
    >
      <div className="flex h-14 items-stretch">
        {items.map((item) => {
          const active = isActive(item.href)
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'relative flex flex-1 flex-col items-center justify-center gap-0.5 text-[10.5px] font-medium transition-colors',
                active ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <span className="relative">
                <item.icon className="h-5 w-5" strokeWidth={active ? 2.25 : 1.75} />
                {item.href === '/tasks' && openTaskCount > 0 && (
                  <span className="absolute -right-2 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold leading-none text-primary-foreground">
                    {openTaskCount > 99 ? '99+' : openTaskCount}
                  </span>
                )}
              </span>
              {item.name}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
