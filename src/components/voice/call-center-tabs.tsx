'use client'

/**
 * CallCenterTabs — the two-surface shell for /call-center.
 *
 * "Overview" is the existing call-center dashboard (recent calls, campaigns, stats);
 * "Power Dialer" is the queue-walking softphone surface that used to live at /dialer
 * (now a redirect here). The active tab is persisted in the URL (?tab=overview|dialer)
 * — mirroring leads-table / deep-analytics — so a bookmark or the old /dialer link
 * lands on the right surface and Back returns to the prior one.
 */

import { useCallback, type ComponentProps } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Phone, PhoneOutgoing } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { CallCenterDashboard } from './call-center-dashboard'
import { ManualDialPad } from './manual-dial-pad'
import { PowerDialer } from './power-dialer'
import type { DialerLead } from '@/lib/voice/dialer-queue'

const VALID_TABS = ['overview', 'dialer']
const DEFAULT_TAB = 'overview'

export function CallCenterTabs({
  dashboard,
  dialerLeads,
}: {
  dashboard: ComponentProps<typeof CallCenterDashboard>
  dialerLeads: DialerLead[]
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const tabParam = searchParams.get('tab')
  const tab = tabParam && VALID_TABS.includes(tabParam) ? tabParam : DEFAULT_TAB

  const setTab = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString())
      params.set('tab', value)
      router.push(`${pathname}?${params.toString()}`)
    },
    [router, pathname, searchParams],
  )

  return (
    <Tabs value={tab} onValueChange={(v) => v && setTab(String(v))}>
      <TabsList>
        <TabsTrigger value="overview" className="gap-1.5">
          <Phone className="h-4 w-4" strokeWidth={1.75} /> Overview
        </TabsTrigger>
        <TabsTrigger value="dialer" className="gap-1.5">
          <PhoneOutgoing className="h-4 w-4" strokeWidth={1.75} /> Power Dialer
        </TabsTrigger>
      </TabsList>

      <TabsContent value="overview" className="mt-6">
        <CallCenterDashboard {...dashboard} />
      </TabsContent>

      <TabsContent value="dialer" className="mt-6">
        <div className="mx-auto max-w-2xl">
          <ManualDialPad />
          <PowerDialer initialLeads={dialerLeads} />
        </div>
      </TabsContent>
    </Tabs>
  )
}
