import { HubNav } from '@/components/dashboard/hub-nav'

/**
 * Analytics hub — Attribution and the Agent KPI dashboard (formerly the
 * top-level /agent-kpi) are consolidated here as sub-routes.
 */
export default function AnalyticsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <HubNav
        items={[
          { name: 'Overview', href: '/analytics', exact: true },
          { name: 'Attribution', href: '/analytics/attribution' },
          { name: 'Agent KPI', href: '/analytics/agents' },
        ]}
      />
      {children}
    </div>
  )
}
