'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import {
  LayoutDashboard,
  Building2,
  Brain,
  GraduationCap,
  Shield,
  Plug,
  Settings,
  Zap,
  X,
  Crosshair,
  Activity,
  DollarSign,
  SlidersHorizontal,
  FlaskConical,
  Wrench,
  Network,
  Users,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  AGENCY_LEVEL_LABELS,
  agencyCan,
  type AgencyAccessLevel,
  type AgencyCapability,
} from '@/lib/auth/permissions'

type NavItem = {
  name: string
  href: string
  icon: React.ElementType
  exact?: boolean
  /** If set, the item is only shown to levels that carry this capability. */
  cap?: AgencyCapability
}

const agencyNavigation: { group: string; items: NavItem[] }[] = [
  {
    group: 'Overview',
    items: [
      { name: 'Agency Home', href: '/agency', icon: LayoutDashboard, exact: true },
      { name: 'Enterprises', href: '/agency/enterprises', icon: Network, cap: 'agency:enterprises_manage' },
      { name: 'Practices', href: '/agency/practices', icon: Building2 },
      { name: 'Spend & Margin', href: '/agency/spend', icon: DollarSign },
      { name: 'Pricing', href: '/agency/pricing', icon: SlidersHorizontal, cap: 'agency:pricing_manage' },
    ],
  },
  {
    group: 'AI Platform',
    items: [
      { name: 'AI Configuration', href: '/agency/ai-config', icon: Brain, cap: 'agency:ai_config' },
      { name: 'AI Training', href: '/agency/ai-training', icon: GraduationCap, cap: 'agency:ai_config' },
      { name: 'AI Learning', href: '/agency/ai-learning', icon: FlaskConical, cap: 'agency:ai_config' },
      { name: 'AI Engine', href: '/ai-engine', icon: Zap },
      { name: 'Sales Intelligence', href: '/ai-engine/sales-intelligence', icon: Crosshair },
      { name: 'AI Audit', href: '/agency/ai-audit', icon: Shield },
      { name: 'AI Improvements', href: '/agency/ai-improvements', icon: Wrench, cap: 'agency:ai_config' },
    ],
  },
  {
    group: 'Settings',
    items: [
      { name: 'Agency Team', href: '/agency/team', icon: Users },
      { name: 'Integrations', href: '/agency/integrations', icon: Plug, cap: 'agency:integrations_manage' },
      { name: 'Agency Settings', href: '/agency/settings', icon: Settings },
    ],
  },
]

function SidebarContent({
  onNavigate,
  level,
}: {
  onNavigate?: () => void
  level: AgencyAccessLevel
}) {
  const pathname = usePathname()

  const sections = agencyNavigation
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => !item.cap || agencyCan(level, item.cap)),
    }))
    .filter((section) => section.items.length > 0)

  return (
    <div className="flex h-full flex-col">
      {/* Brand mark */}
      <div className="px-5 pt-6 pb-5 border-b border-aurea-border">
        <div className="flex items-baseline gap-2">
          <Activity className="h-[18px] w-[18px] self-center text-aurea-ink" strokeWidth={2} />
          <span className="text-[15px] font-medium tracking-tight text-aurea-ink">
            Lead Intelligence
          </span>
          <span className="aurea-eyebrow">Agency</span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-5">
        {sections.map((section) => (
          <div key={section.group}>
            <p className="px-3 mb-1.5 text-[11px] font-semibold uppercase tracking-[0.15em] text-aurea-ink-3">
              {section.group}
            </p>
            <div className="space-y-0.5">
              {section.items.map((item) => {
                const isActive = item.exact
                  ? pathname === item.href
                  : pathname === item.href || pathname.startsWith(item.href + '/')
                return (
                  <Link
                    key={item.name}
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'group flex items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] transition-colors duration-150',
                      isActive
                        ? 'bg-aurea-surface-2 font-semibold text-aurea-ink'
                        : 'font-medium text-aurea-ink-2 hover:bg-aurea-surface-2/60 hover:text-aurea-ink'
                    )}
                  >
                    <item.icon
                      className={cn(
                        'h-[17px] w-[17px] shrink-0 transition-colors',
                        isActive
                          ? 'text-aurea-primary'
                          : 'text-aurea-ink-3 group-hover:text-aurea-ink'
                      )}
                      strokeWidth={2}
                    />
                    <span className="flex-1 truncate">{item.name}</span>
                  </Link>
                )
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="border-t border-aurea-border px-5 py-4">
        <div className="flex items-center gap-2">
          <Shield className="h-3.5 w-3.5 text-aurea-primary" strokeWidth={2} />
          <p className="text-[11px] font-medium text-aurea-ink-2">
            {AGENCY_LEVEL_LABELS[level]}
            {level === 'owner' ? ' · Full access' : level === 'manager' ? ' · Operate practices' : ' · Read-only'}
          </p>
        </div>
        <p className="mt-1 text-[10.5px] leading-relaxed text-aurea-ink-3">
          {level === 'analyst' ? 'You have read-only access.' : 'Changes here affect all practices.'}
        </p>
      </div>
    </div>
  )
}

// Desktop sidebar — flat editorial rail
export function AgencySidebar({ level }: { level: AgencyAccessLevel }) {
  return (
    <aside className="aurea-rail hidden lg:flex h-full w-64 flex-col border-r">
      <SidebarContent level={level} />
    </aside>
  )
}

// Mobile sidebar — overlay drawer
export function AgencyMobileSidebar({
  open,
  onClose,
  level,
}: {
  open: boolean
  onClose: () => void
  level: AgencyAccessLevel
}) {
  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-40 bg-aurea-ink/30 backdrop-blur-sm lg:hidden animate-in fade-in-0 duration-200"
          onClick={onClose}
        />
      )}
      <aside
        className={cn(
          'aurea-rail fixed inset-y-0 left-0 z-50 w-72 flex flex-col border-r lg:hidden transition-transform duration-300 ease-in-out',
          open ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-4 right-3 h-8 w-8 z-10 text-aurea-ink-3 hover:text-aurea-ink hover:bg-aurea-surface-2"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
        <SidebarContent onNavigate={onClose} level={level} />
      </aside>
    </>
  )
}
