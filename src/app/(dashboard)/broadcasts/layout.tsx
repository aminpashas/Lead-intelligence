import { HubNav } from '@/components/dashboard/hub-nav'

/**
 * Broadcasts hub — consolidates the former standalone Mass SMS, Mass Email, and
 * Broadcast Audit pages into one section with sub-routes:
 *   /broadcasts/sms · /broadcasts/email · /broadcasts/audit
 */
export default function BroadcastsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <HubNav
        items={[
          { name: 'SMS', href: '/broadcasts/sms' },
          { name: 'Email', href: '/broadcasts/email' },
          { name: 'Audit', href: '/broadcasts/audit' },
        ]}
      />
      {children}
    </div>
  )
}
