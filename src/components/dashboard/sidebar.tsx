'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { useOrgStore } from '@/lib/store/use-org'
import { canAccessRoute, isFocusedStaff, ROLE_LABELS, ROLE_COLORS, type PracticeRole } from '@/lib/auth/permissions'
import {
  LayoutDashboard,
  Users,
  GitBranch,
  MessageSquare,
  Activity,
  Megaphone,
  BarChart3,
  Settings,
  Calendar,
  Target,
  Flame,
  CircleCheckBig,
  RefreshCw,
  X,
  Building2,
  Phone,
  PhoneOutgoing,
  FolderHeart,
  FileSignature,
  History,
  ListTodo,
  SlidersHorizontal,
  ChevronsUpDown,
  PanelLeftClose,
  PanelLeftOpen,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { AccountMenu } from './account-menu'

type NavItem = {
  name: string
  href: string
  icon: LucideIcon
}

type NavGroup = {
  label: string
  items: NavItem[]
}

// Consolidated, grouped practice navigation. The former flat list of 23 items is
// organized into four sections by job-to-be-done; low-traffic destinations are
// folded into section hubs (Campaigns, Analytics, Settings) as tabs instead of
// competing for top-level nav slots. Agency-only tooling lives in /agency, and
// account/admin destinations live under the Settings hub (pinned footer link).
const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Workspace',
    items: [
      { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
      { name: 'Pipeline', href: '/pipeline', icon: GitBranch },
      { name: 'In Closing', href: '/closing', icon: Flame },
      { name: 'Leads', href: '/leads', icon: Users },
      { name: 'Tasks', href: '/tasks', icon: ListTodo },
      { name: 'Conversations', href: '/conversations', icon: MessageSquare },
      { name: 'Monitor', href: '/monitor', icon: Activity },
      { name: 'Call Center', href: '/call-center', icon: Phone },
      { name: 'Dialer', href: '/dialer', icon: PhoneOutgoing },
      { name: 'Appointments', href: '/appointments', icon: Calendar },
      { name: 'Tasks', href: '/tasks', icon: ListTodo },
    ],
  },
  {
    label: 'Engage',
    items: [
      { name: 'Campaigns', href: '/campaigns', icon: Megaphone },
      { name: 'Reactivation', href: '/reactivation', icon: RefreshCw },
    ],
  },
  {
    label: 'Revenue',
    items: [
      { name: 'Post-Close', href: '/post-close', icon: CircleCheckBig },
      { name: 'Cases', href: '/cases', icon: FolderHeart },
      { name: 'Contracts', href: '/contracts', icon: FileSignature },
    ],
  },
  {
    label: 'Insights',
    items: [
      { name: 'Analytics', href: '/analytics', icon: BarChart3 },
      { name: 'Automation', href: '/automation', icon: SlidersHorizontal },
      { name: 'Audit Trail', href: '/audit', icon: History },
    ],
  },
]

const SETTINGS_ITEM: NavItem = { name: 'Settings', href: '/settings', icon: Settings }

// The browse-the-whole-book surfaces. Hidden from focused (clinical) staff so
// their nav stays on today's work — they still reach a single patient by opening
// it from a consult or conversation. These pages also hard-redirect focused
// staff server-side, so this is the nav mirror of that guard, not the guard.
const FOCUSED_STAFF_HIDDEN_HREFS = new Set(['/pipeline', '/closing', '/post-close', '/leads'])

const SIDEBAR_COLLAPSED_KEY = 'li:sidebar-collapsed'

// Persist the collapsed choice across route changes and reloads. We initialize
// to `false` (expanded) so the server and first client render agree, then read
// the stored preference in an effect — avoiding a hydration mismatch.
function useSidebarCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    setCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1')
  }, [])

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0')
      return next
    })
  }

  return [collapsed, toggle]
}

// Open human-task count for the Tasks nav badge (Workstream D2). Fetched once
// on mount + refreshed on a slow interval; fails silent (badge just hides).
function useOpenTaskCount(): number {
  const [count, setCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    const load = () =>
      fetch('/api/tasks?status=active&limit=1')
        .then((res) => (res.ok ? res.json() : null))
        .then((json) => {
          if (!cancelled && json) setCount(json.openCount ?? 0)
        })
        .catch(() => { /* badge is a courtesy — never surface the failure */ })
    load()
    const t = setInterval(load, 60_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])

  return count
}

function NavLink({
  item,
  isActive,
  collapsed,
  onNavigate,
  badgeCount,
}: {
  item: NavItem
  isActive: boolean
  collapsed?: boolean
  onNavigate?: () => void
  badgeCount?: number
}) {
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={isActive ? 'page' : undefined}
      title={collapsed ? item.name : undefined}
      className={cn(
        'group flex items-center gap-3 rounded-lg py-2 text-[13.5px] transition-colors duration-150',
        collapsed ? 'justify-center px-2' : 'px-3',
        isActive
          ? 'bg-secondary font-semibold text-foreground'
          : 'font-medium text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
      )}
    >
      <item.icon
        className={cn(
          'h-[17px] w-[17px] shrink-0 transition-colors',
          isActive ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'
        )}
        strokeWidth={2}
      />
      {!collapsed && (
        <>
          <span className="flex-1">{item.name}</span>
          {!!badgeCount && (
            <Badge
              variant="outline"
              className="ml-auto h-4 px-1.5 text-[10px] font-semibold text-muted-foreground"
            >
              {badgeCount > 99 ? '99+' : badgeCount}
            </Badge>
          )}
        </>
      )}
    </Link>
  )
}

function SidebarContent({
  onNavigate,
  collapsed = false,
  onToggleCollapse,
}: {
  onNavigate?: () => void
  collapsed?: boolean
  onToggleCollapse?: () => void
}) {
  const pathname = usePathname()
  const { userProfile } = useOrgStore()
  const role = (userProfile?.role || 'member') as PracticeRole
  const openTaskCount = useOpenTaskCount()

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/')

  // Filter each group by role, then drop any group left with no visible items.
  // Focused (clinical) staff additionally lose the pipeline kanban and the full
  // lead book — their nav is the Today-work set.
  const focused = isFocusedStaff(role)
  const groups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) =>
        canAccessRoute(role, item.href) &&
        !(focused && FOCUSED_STAFF_HIDDEN_HREFS.has(item.href))
    ),
  })).filter((group) => group.items.length > 0)

  const canSeeSettings = canAccessRoute(role, SETTINGS_ITEM.href)

  return (
    <>
      {/* Logo + collapse toggle */}
      <div
        className={cn(
          'flex h-16 items-center border-b border-border shrink-0',
          collapsed ? 'justify-center px-2' : 'gap-2.5 px-5'
        )}
      >
        <Target className="h-[18px] w-[18px] shrink-0 text-foreground" strokeWidth={2} />
        {!collapsed && (
          <>
            <span className="text-[15px] font-medium tracking-tight text-foreground">Lead Intelligence</span>
            <span className="aurea-eyebrow">Practice</span>
          </>
        )}
        {onToggleCollapse && !collapsed && (
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto h-7 w-7 text-muted-foreground"
            onClick={onToggleCollapse}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
          >
            <PanelLeftClose className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Expand button — only rendered in the collapsed rail */}
      {onToggleCollapse && collapsed && (
        <div className="flex justify-center px-2 pt-2 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground"
            onClick={onToggleCollapse}
            aria-label="Expand sidebar"
            title="Expand sidebar"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </Button>
        </div>
      )}

      {/* Grouped navigation */}
      <nav className={cn('flex-1 overflow-y-auto', collapsed ? 'px-2 py-3' : 'p-3')}>
        {groups.map((group, i) => (
          <div key={group.label} className={cn(i > 0 && (collapsed ? 'mt-3' : 'mt-5'))}>
            {collapsed ? (
              i > 0 && <div className="mx-2 mb-2 border-t border-border/60" />
            ) : (
              <p className="px-3 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60">
                {group.label}
              </p>
            )}
            <div className="space-y-0.5">
              {group.items.map((item) => (
                <NavLink
                  key={item.href}
                  item={item}
                  isActive={isActive(item.href)}
                  collapsed={collapsed}
                  onNavigate={onNavigate}
                  badgeCount={item.href === '/tasks' ? openTaskCount : undefined}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer — pinned Settings + user card */}
      <div className={cn('border-t shrink-0 space-y-3', collapsed ? 'px-2 py-3' : 'p-3')}>
        {canSeeSettings && (
          <NavLink
            item={SETTINGS_ITEM}
            isActive={isActive(SETTINGS_ITEM.href)}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
        )}
        <AccountMenu
          align="start"
          side="top"
          onNavigate={onNavigate}
          triggerClassName={cn(
            'flex w-full items-center rounded-lg text-left hover:bg-secondary/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            collapsed ? 'justify-center p-1' : 'gap-2 px-1 py-1'
          )}
        >
          <span
            className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0"
            title={collapsed ? userProfile?.full_name || 'Practice Dashboard' : undefined}
          >
            <Building2 className="h-4 w-4 text-primary" />
          </span>
          {!collapsed && (
            <>
              <span className="flex-1 min-w-0 flex flex-col items-start">
                <span className="text-xs font-medium truncate max-w-full">{userProfile?.full_name || 'Practice Dashboard'}</span>
                <Badge
                  variant="outline"
                  className={cn('text-[10px] px-1.5 py-0 h-4 font-medium', ROLE_COLORS[role])}
                >
                  {ROLE_LABELS[role] || role}
                </Badge>
              </span>
              <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
            </>
          )}
        </AccountMenu>
      </div>
    </>
  )
}

// Desktop sidebar — always visible on lg+, collapsible to an icon-only rail
export function Sidebar() {
  const [collapsed, toggleCollapsed] = useSidebarCollapsed()

  return (
    <aside
      className={cn(
        'hidden lg:flex h-full flex-col border-r bg-card transition-[width] duration-200 ease-in-out',
        collapsed ? 'w-[68px]' : 'w-64'
      )}
    >
      <SidebarContent collapsed={collapsed} onToggleCollapse={toggleCollapsed} />
    </aside>
  )
}

// Mobile sidebar — overlay drawer
export function MobileSidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden animate-in fade-in-0 duration-200"
          onClick={onClose}
        />
      )}

      {/* Drawer */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-72 flex flex-col bg-card shadow-xl lg:hidden transition-transform duration-300 ease-in-out',
          open ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {/* Close button */}
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-3 right-3 h-8 w-8 z-10"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>

        <SidebarContent onNavigate={onClose} />
      </aside>
    </>
  )
}
