import { HubNav } from '@/components/dashboard/hub-nav'

/**
 * Settings hub — account & admin destinations are consolidated here as tabs:
 *   General · Team · Billing · AI Control · Connectors · Legal · Templates
 *
 * Each tab is permission-filtered by HubNav (via canAccessRoute), so a nurse
 * sees only General (and the bar collapses to nothing), while an agency_admin
 * sees Connectors. Server-side gates on individual subtrees (e.g.
 * settings/connectors/layout.tsx) still apply underneath this chrome.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <HubNav
        items={[
          { name: 'General', href: '/settings', exact: true },
          { name: 'Team', href: '/settings/team' },
          { name: 'Billing', href: '/settings/billing' },
          { name: 'AI Control', href: '/settings/ai' },
          { name: 'Financing', href: '/settings/financing' },
          { name: 'Live Transfer', href: '/settings/live-transfer' },
          { name: 'Connectors', href: '/settings/connectors' },
          { name: 'Legal', href: '/settings/legal' },
          { name: 'Templates', href: '/settings/contracts/templates' },
        ]}
      />
      {children}
    </div>
  )
}
