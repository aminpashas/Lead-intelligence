'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { useOrgStore } from '@/lib/store/use-org'
import { canAccessRoute, type PracticeRole } from '@/lib/auth/permissions'

export type HubNavItem = {
  name: string
  href: string
  /** When true, the tab is only active on an exact pathname match (use for a hub's index tab). */
  exact?: boolean
}

/**
 * Horizontal, URL-driven tab bar for consolidated section hubs (Broadcasts,
 * Analytics, Campaigns, Settings, …). Each tab is a real route, so the browser
 * back button and deep links work. Tabs the current role can't reach are hidden
 * via the same canAccessRoute check the sidebar uses; if only one (or zero) tabs
 * remain, the bar renders nothing (there's nothing to switch between).
 */
export function HubNav({ items, className }: { items: HubNavItem[]; className?: string }) {
  const pathname = usePathname()
  const { userProfile } = useOrgStore()
  const role = (userProfile?.role || 'member') as PracticeRole

  const visible = items.filter((item) => canAccessRoute(role, item.href))
  if (visible.length <= 1) return null

  return (
    <nav
      className={cn(
        'mb-6 flex items-center gap-0.5 border-b border-border/70 overflow-x-auto',
        className
      )}
    >
      {visible.map((item) => {
        const isActive = item.exact
          ? pathname === item.href
          : pathname === item.href || pathname.startsWith(item.href + '/')
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'relative -mb-px whitespace-nowrap px-3 py-2.5 text-[13.5px] transition-colors duration-150',
              isActive
                ? 'font-semibold text-foreground'
                : 'font-medium text-muted-foreground hover:text-foreground'
            )}
          >
            {item.name}
            {isActive && (
              <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-primary" />
            )}
          </Link>
        )
      })}
    </nav>
  )
}
