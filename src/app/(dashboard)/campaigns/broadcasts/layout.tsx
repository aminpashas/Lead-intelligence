import { HubNav } from '@/components/dashboard/hub-nav'

/**
 * Broadcasts is now a section of the Campaigns hub. Its own sub-tab bar switches
 * between the one-time Mass SMS / Mass Email composers and the send Audit.
 */
export default function BroadcastsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <HubNav
        items={[
          { name: 'SMS', href: '/campaigns/broadcasts/sms' },
          { name: 'Email', href: '/campaigns/broadcasts/email' },
          { name: 'Audit', href: '/campaigns/broadcasts/audit' },
        ]}
      />
      {children}
    </div>
  )
}
