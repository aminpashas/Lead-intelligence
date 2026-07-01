import { HubNav } from '@/components/dashboard/hub-nav'

/**
 * Campaigns hub — the Funnel Playbook (formerly a top-level nav item at /funnel)
 * now lives here as a sub-route at /campaigns/playbook.
 */
export default function CampaignsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <HubNav
        items={[
          { name: 'Campaigns', href: '/campaigns', exact: true },
          { name: 'Funnel Playbook', href: '/campaigns/playbook' },
        ]}
      />
      {children}
    </div>
  )
}
