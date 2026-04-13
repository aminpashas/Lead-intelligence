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
  ChevronRight,
  X,
  Crosshair,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

const agencyNavigation = [
  {
    group: 'Overview',
    items: [
      { name: 'Agency Home', href: '/agency', icon: LayoutDashboard, exact: true },
      { name: 'Practices', href: '/agency/practices', icon: Building2 },
    ],
  },
  {
    group: 'AI Platform',
    items: [
      { name: 'AI Configuration', href: '/agency/ai-config', icon: Brain },
      { name: 'AI Training', href: '/agency/ai-training', icon: GraduationCap },
      { name: 'AI Engine', href: '/ai-engine', icon: Zap },
      { name: 'Sales Intelligence', href: '/ai-engine/sales-intelligence', icon: Crosshair },
      { name: 'AI Audit', href: '/agency/ai-audit', icon: Shield },
    ],
  },
  {
    group: 'Settings',
    items: [
      { name: 'Integrations', href: '/agency/integrations', icon: Plug },
      { name: 'Agency Settings', href: '/agency/settings', icon: Settings },
    ],
  },
]

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()

  return (
    <>
      {/* Logo */}
      <div className="flex h-16 items-center gap-2 border-b border-agency-border px-6 shrink-0">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center shadow-lg">
            <Zap className="h-4 w-4 text-white" />
          </div>
          <div>
            <span className="text-sm font-bold text-white">Lead Intelligence</span>
            <div className="flex items-center gap-1 mt-0.5">
              <Badge className="h-4 text-[10px] px-1.5 bg-violet-500/20 text-violet-300 border-violet-500/30 border font-semibold tracking-wide">
                AGENCY
              </Badge>
            </div>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-6 p-4 overflow-y-auto">
        {agencyNavigation.map((section) => (
          <div key={section.group}>
            <p className="px-3 mb-2 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
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
                    className={cn(
                      'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200',
                      isActive
                        ? 'bg-gradient-to-r from-violet-500/20 to-indigo-500/10 text-white shadow-sm border border-violet-500/20'
                        : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
                    )}
                  >
                    <item.icon
                      className={cn(
                        'h-4 w-4 shrink-0 transition-colors',
                        isActive ? 'text-violet-400' : 'text-slate-500 group-hover:text-slate-300'
                      )}
                    />
                    <span className="flex-1">{item.name}</span>
                    {isActive && <ChevronRight className="h-3 w-3 text-violet-400/60" />}
                  </Link>
                )
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="border-t border-slate-800 p-4 shrink-0">
        <div className="rounded-xl bg-gradient-to-r from-violet-500/10 to-indigo-500/5 border border-violet-500/10 p-3">
          <div className="flex items-center gap-2 mb-1">
            <Zap className="h-3 w-3 text-violet-400" />
            <span className="text-xs font-semibold text-violet-300">Agency Admin Mode</span>
          </div>
          <p className="text-[10px] text-slate-500 leading-relaxed">
            Full platform access. Changes here affect all practices.
          </p>
        </div>
      </div>
    </>
  )
}

// Desktop sidebar
export function AgencySidebar() {
  return (
    <aside className="hidden lg:flex h-full w-64 flex-col bg-slate-950 border-r border-slate-800">
      <SidebarContent />
    </aside>
  )
}

// Mobile sidebar — overlay drawer
export function AgencyMobileSidebar({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/60 lg:hidden animate-in fade-in-0 duration-200"
          onClick={onClose}
        />
      )}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-72 flex flex-col bg-slate-950 shadow-2xl border-r border-slate-800 lg:hidden transition-transform duration-300 ease-in-out',
          open ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-3 right-3 h-8 w-8 z-10 text-slate-400 hover:text-white hover:bg-slate-800"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
        <SidebarContent onNavigate={onClose} />
      </aside>
    </>
  )
}
