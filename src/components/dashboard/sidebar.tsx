'use client'

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
  Megaphone,
  BarChart3,
  Settings,
  Calendar,
  Target,
  RefreshCw,
  X,
  Building2,
  Phone,
  PhoneOutgoing,
  FolderHeart,
  FileSignature,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

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
      { name: 'Leads', href: '/leads', icon: Users },
      { name: 'Conversations', href: '/conversations', icon: MessageSquare },
      { name: 'Call Center', href: '/call-center', icon: Phone },
      { name: 'Dialer', href: '/dialer', icon: PhoneOutgoing },
      { name: 'Appointments', href: '/appointments', icon: Calendar },
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
      { name: 'Cases', href: '/cases', icon: FolderHeart },
      { name: 'Contracts', href: '/contracts', icon: FileSignature },
    ],
  },
  {
    label: 'Insights',
    items: [
      { name: 'Analytics', href: '/analytics', icon: BarChart3 },
    ],
  },
]

const SETTINGS_ITEM: NavItem = { name: 'Settings', href: '/settings', icon: Settings }

// The browse-the-whole-book surfaces. Hidden from focused (clinical) staff so
// their nav stays on today's work — they still reach a single patient by opening
// it from a consult or conversation. These pages also hard-redirect focused
// staff server-side, so this is the nav mirror of that guard, not the guard.
const FOCUSED_STAFF_HIDDEN_HREFS = new Set(['/pipeline', '/leads'])

function NavLink({
  item,
  isActive,
  onNavigate,
}: {
  item: NavItem
  isActive: boolean
  onNavigate?: () => void
}) {
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={isActive ? 'page' : undefined}
      className={cn(
        'group flex items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] transition-colors duration-150',
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
      {item.name}
    </Link>
  )
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()
  const { userProfile } = useOrgStore()
  const role = (userProfile?.role || 'member') as PracticeRole

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
      {/* Logo */}
      <div className="flex h-16 items-center gap-2.5 border-b border-border px-5 shrink-0">
        <Target className="h-[18px] w-[18px] text-foreground" strokeWidth={2} />
        <span className="text-[15px] font-medium tracking-tight text-foreground">Lead Intelligence</span>
        <span className="aurea-eyebrow">Practice</span>
      </div>

      {/* Grouped navigation */}
      <nav className="flex-1 overflow-y-auto p-3">
        {groups.map((group, i) => (
          <div key={group.label} className={cn(i > 0 && 'mt-5')}>
            <p className="px-3 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60">
              {group.label}
            </p>
            <div className="space-y-0.5">
              {group.items.map((item) => (
                <NavLink
                  key={item.href}
                  item={item}
                  isActive={isActive(item.href)}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer — pinned Settings + user card */}
      <div className="border-t p-3 shrink-0 space-y-3">
        {canSeeSettings && (
          <NavLink
            item={SETTINGS_ITEM}
            isActive={isActive(SETTINGS_ITEM.href)}
            onNavigate={onNavigate}
          />
        )}
        <div className="flex items-center gap-2 px-1">
          <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Building2 className="h-4 w-4 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium truncate">{userProfile?.full_name || 'Practice Dashboard'}</p>
            <Badge
              variant="outline"
              className={cn('text-[10px] px-1.5 py-0 h-4 font-medium', ROLE_COLORS[role])}
            >
              {ROLE_LABELS[role] || role}
            </Badge>
          </div>
        </div>
      </div>
    </>
  )
}

// Desktop sidebar — always visible on lg+
export function Sidebar() {
  return (
    <aside className="hidden lg:flex h-full w-64 flex-col border-r bg-card">
      <SidebarContent />
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
