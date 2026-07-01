import { HubNav } from '@/components/dashboard/hub-nav'

/**
 * Campaigns hub — the "who" (Audiences / Smart Lists), the automated "nurture"
 * (Campaigns sequences), the one-time "blast" (Broadcasts), and the Funnel Playbook.
 */
export default function CampaignsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <HubNav
        items={[
          { name: 'Campaigns', href: '/campaigns', exact: true },
          { name: 'Audiences', href: '/campaigns/audiences' },
          { name: 'Broadcasts', href: '/campaigns/broadcasts' },
          { name: 'Funnel Playbook', href: '/campaigns/playbook' },
        ]}
      />
      {children}
    </div>
  )
}
