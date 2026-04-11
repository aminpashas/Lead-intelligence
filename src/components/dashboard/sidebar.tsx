'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import {
  LayoutDashboard,
  Users,
  GitBranch,
  MessageSquare,
  Megaphone,
  BarChart3,
  Settings,
  Brain,
  Calendar,
  Target,
  GraduationCap,
  Shield,
  Crosshair,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'

const navigation = [
  { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { name: 'Pipeline', href: '/pipeline', icon: GitBranch },
  { name: 'Funnel Playbook', href: '/funnel', icon: Target },
  { name: 'Leads', href: '/leads', icon: Users },
  { name: 'Conversations', href: '/conversations', icon: MessageSquare },
  { name: 'Campaigns', href: '/campaigns', icon: Megaphone },
  { name: 'Appointments', href: '/appointments', icon: Calendar },
  { name: 'Analytics', href: '/analytics', icon: BarChart3 },
  { name: 'AI Engine', href: '/ai-engine', icon: Brain },
  { name: 'Sales Intelligence', href: '/ai-engine/sales-intelligence', icon: Crosshair },
  { name: 'AI Training', href: '/ai-training', icon: GraduationCap },
  { name: 'AI Audit', href: '/ai-audit', icon: Shield },
  { name: 'Settings', href: '/settings', icon: Settings },
]

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()

  return (
    <>
      {/* Logo */}
      <div className="flex h-16 items-center gap-2 border-b px-6 shrink-0">
        <Brain className="h-6 w-6 text-primary" />
        <span className="text-lg font-bold">Lead Intelligence</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 p-3 overflow-y-auto">
        {navigation.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(item.href + '/')
          return (
            <Link
              key={item.name}
              href={item.href}
              onClick={onNavigate}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200',
                isActive
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.name}
            </Link>
          )
        })}
      </nav>

      {/* Footer */}
      <div className="border-t p-4 shrink-0">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
            <LayoutDashboard className="h-4 w-4 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium truncate">Implant CRM</p>
            <p className="text-xs text-muted-foreground">v1.0.0</p>
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
