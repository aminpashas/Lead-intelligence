'use client'

import { usePathname } from 'next/navigation'
import { HubNav } from '@/components/dashboard/hub-nav'

/**
 * Leads hub — Smart Lists (formerly the top-level /smart-lists) is now a view of
 * Leads at /leads/lists. The tab bar is shown on the list-level routes but hidden
 * on an individual lead's detail page (/leads/[id]), which has its own chrome.
 */
export default function LeadsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const showTabs =
    pathname === '/leads' ||
    pathname === '/leads/lists' ||
    pathname.startsWith('/leads/lists/')

  return (
    <div>
      {showTabs && (
        <HubNav
          items={[
            { name: 'All Leads', href: '/leads', exact: true },
            { name: 'Smart Lists', href: '/leads/lists' },
          ]}
        />
      )}
      {children}
    </div>
  )
}
